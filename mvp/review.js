/* Katse · Review & sign. The review of a branch, told as a tree that grows out of the spot you clicked in the
   graph: every agent that rebuilt the change from the ticket is a branch (labelled with its strategy), its test
   run sprouts as a twig, the attacker crawls in from below. When two branches meet the camera dives into the
   junction to watch the two agents argue; everything merges into one trunk that ends in the verdict, and the
   verdict card is where you sign (or send it back, with the agents' fix when the review found a problem).
   No review yet? Review & sign starts a real one and the tree grows live from its events.
   The story is one timeline: each frame is a pure function of the time, so camera, branches and bubbles stay
   in step, and Skip / Replay are a jump in time.
   Uses app.js globals: $, esc, mk, base, api, store, english, S, G, PAL, CAND, VERDICT, OPTION, HARD,
   modelName, toScreen, verify, renderBar, reloadPRs, secs, RM. */
(() => {
  const F = { open: false, story: null, tl: null, t: 0, raf: 0, last: 0, playing: false, live: false, origin: null, zone: null, spotRaw: null, code: '', fix: null, card: 'verdict', signMode: 'aprobar', answers: {}, hideT: 0, W: 0, H: 0, phone: false, stat: '', seq: 0 };
  const sec = $('fix'), CAM = $('fcam'), WORLD = $('fworld'), SCR = $('fscr'), BLOBS = $('fblobs'), BLUR = $('fgooblur'), SAYS = $('fsays'), CARD = $('fverd');
  const COL = { PR: '#f5f5f7', ATK: '#f2a99f', cands: ['#cde4ee', '#e3dcf4', '#f2c6d9'] };
  const EXPECT = { quick: 0, standard: 2, deep: 3 };

  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const sm = (x) => { x = clamp01(x); return x * x * (3 - 2 * x); };
  const ease = (x) => { x = clamp01(x); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
  const grow = (x) => 0.5 - 0.5 * Math.cos(Math.PI * clamp01(x));
  const lerp = (a, b, k) => a + (b - a) * k;
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const mix = (a, b, k) => { const x = rgb(a), y = rgb(b), q = clamp01(k); return '#' + x.map((v, i) => Math.round(lerp(v, y[i], q)).toString(16).padStart(2, '0')).join(''); };
  const cut = (t, n = 110) => { const x = String(t || '').replace(/\s+/g, ' ').trim(); return x.length > n ? x.slice(0, n - 1).replace(/[\s,;:]+\S*$/, '') + '…' : x; };
  const speakMs = (s) => Math.max(1800, Math.min(3300, 1000 + s.length * 20));
  const TONE = { ok: PAL.ok, bad: PAL.bad, warn: PAL.warn, no: '#55555c', file: PAL.file, test: '#e3dcf4', doc: '#4a4a52' };
  const CHECK = [[/mezcla|merge/i, 'merges clean'], [/fallan sin|fail without|red.*green/i, 'red → green'], [/no rompe|existing/i, 'suite intact'], [/defecto|defect|mutant/i, 'mutants'], [/necesario|necessary|rewind/i, 'rewind'], [/alternativ/i, 'rebuilt from base'], [/veredicto|verdict/i, 'on evidence'], [/compila|build/i, 'builds']];
  const checkLabel = (t) => (CHECK.find(([re]) => re.test(t)) || [0, cut(t, 16)])[1];
  /* The PR's files (code first) and, under each, the regions it changed: green where an agent also wrote it,
     red where only the PR did. These are the twigs and sub-twigs of the PR branch. */
  function filesFor(files, regions, real) {
    const rank = { source: 0, test: 1, config: 2, doc: 3 };
    return (files || []).filter((f) => f.kind !== 'derived').sort((a, b) => (rank[a.kind] ?? 4) - (rank[b.kind] ?? 4) || b.add + b.del - (a.add + a.del)).slice(0, 4).map((f) => ({
      label: cut(base(f.path), 18), tone: f.kind === 'test' ? 'test' : f.kind === 'doc' ? 'doc' : 'file',
      regions: (regions || []).filter((r) => r.file === f.path).slice(0, 4).map((r) => ({ label: ':' + r.start, tone: f.kind === 'doc' ? 'doc' : f.kind === 'test' ? 'test' : !real ? 'file' : r.who?.length ? 'ok' : 'bad' })),
    }));
  }

  /* ── The story: who rebuilt it, who argued with whom, how it ended ── */
  function spotSummary(spot, built) {
    if (!spot) return null;
    const who = spot.who, all = built.length && who && built.every((a) => who.includes(a.id));
    const text = who == null ? spot.info : !who.length ? 'Only the PR wrote this spot. Read it.' : all ? 'Every agent wrote this spot too. Reproduced.' : `${who.join(' and ')} also wrote this spot.`;
    return { where: `${spot.file}:${spot.start}`, text, tone: who == null ? spot.tone : !who.length ? 'bad' : all ? 'ok' : 'warn' };
  }
  function realStory(b, spot) {
    const ev = (v) => (b.evidence || []).filter((e) => e.version === v).pop();
    const deb = (Array.isArray(b.debate) ? b.debate : b.debate?.entries || []).filter((d) => d.status !== 'incomplete');
    const said = (id, round) => deb.find((d) => d.candidate === id && (d.round || 'proposals') === round);
    const cands = (b.candidates || []).filter((c) => c.status !== 'duplicate').slice(0, 3);
    const agents = cands.map((c, i) => {
      const e = ev(c.id);
      return {
        id: c.id, model: modelName(c.model), wanted: c.modelFallback && c.requestedModel ? modelName(c.requestedModel) : null, strategy: cut(c.strategy, 42),
        color: COL.cands[i], built: c.status === 'built', fail: c.status === 'built' ? null : CAND[c.status] || c.status,
        tests: e && e.ran != null ? { ok: e.status === 'passed', ran: e.ran } : null, summary: c.summary, patch: c.patch, here: !spot?.who || spot.who.includes(c.id),
        files: ((F.vers?.candidates || []).find((x) => x.id === c.id)?.files || []).map((x) => cut(base(x), 18)), decisions: (c.decisions || []).length,
      };
    });
    const built = agents.filter((a) => a.built), part = built.filter((a) => a.here), orig = ev('original');
    let j1 = null;
    if (part.length >= 2) {
      const [a, c] = part, L = [];
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
    const withTests = part.filter((a) => a.tests);
    const consOk = withTests.length ? withTests.every((a) => a.tests.ok) : null;
    const st = b.verdict?.status;
    const nodePending=b.graphReview?.nodes.some(n=>n.status!=='verified');
    const win = st === 'ready-for-human' && !nodePending ? 'PR' : st === 'request-changes' ? 'CONS' : 'none';
    const L2 = [['PR', orig ? (orig.status === 'passed' ? `I pass all ${orig.ran} tests in the suite.` : `My suite run: ${orig.status}, ${orig.ran} tests.`) : 'The change, as written.']];
    if (part.length) L2.push(['CONS', consOk === false ? `Our rebuilds fail the suite. ${cut(part[0].summary, 70)}` : consOk ? `Ours pass too. ${cut(part[0].summary, 70)}` : cut(part[0].summary), atk ? null : 'badge']);
    if (atk) {
      L2.push(['ATK', cut(atk.hypothesis || atk.mission)]);
      L2.push(['ATK', onPR === 'passed' ? 'Refuted. The PR passes it.' : onPR === 'failed' ? 'The PR fails it.' : 'It did not run on the PR in time.', 'badge']);
    }
    if (part.length || atk) L2.push(win === 'PR' ? [part.length ? 'CONS' : 'ATK', part.length ? 'The PR holds up. Take it.' : 'It holds up.'] : win === 'CONS' ? ['PR', 'Fair. I need changes.'] : [part.length ? 'CONS' : 'PR', 'Not enough evidence to decide.']);
    const prOk = atk ? (onPR === 'passed' ? true : onPR === 'failed' ? false : null) : orig ? orig.status === 'passed' : null;
    const facts = [
      orig && `The PR · ${orig.status} · ${orig.ran} tests`,
      ...built.filter((a) => a.tests).map((a) => `${a.id} · ${a.tests.ok ? 'passed' : 'failed'} · ${a.tests.ran} tests`),
      ...agents.filter((a) => !a.built).map((a) => `${a.id} · ${a.fail}`),
      finds.length && `${finds.length} ${finds.length === 1 ? 'attack' : 'attacks'} · ${finds.filter((x) => x.classification === 'refuted').length} refuted`,
      ...agents.filter((a) => a.wanted).map((a) => `${a.id} ran on ${a.model}: ${a.wanted} was not available`),
    ].filter(Boolean);
    return {
      live: false, agents, prTests: orig && orig.ran != null ? { ok: orig.status === 'passed', ran: orig.ran } : null, j1, j2: { lines: L2 },
      prFiles: filesFor(b.files, F.vers?.regions, true), checks: (b.claims || []).map((c) => ({ label: checkLabel(c.text), tone: CLAIM[c.status]?.[0] || 'no' })),
      roots: (b.contract?.expectations || []).map((x) => `${x.id} ${cut(x.behavior || '', 20)}`),
      atkOut: (f?.outcomes || []).map((o) => ({ label: `${o.version === 'original' ? 'PR' : o.version} ${o.outcome === 'passed' ? '✓' : o.outcome === 'failed' ? '✕' : '·'}`, tone: o.outcome === 'passed' ? 'ok' : o.outcome === 'failed' ? 'bad' : 'no' })),
      atk: atk ? { model: modelName(atk.attacker) } : null, prOk, consOk, spot: spotSummary(spot, built),
      fixFrom: win === 'CONS' && part.length ? part.find((a) => a.tests?.ok) || part[0] : null,
      verdict: { score: b.verdict?.score?.value ?? null, label: b.graphReview && st==='ready-for-human' ? (nodePending?'Node evidence pending':'Selected scope checked') : VERDICT[st]?.[1] || b.verdict?.label || 'Pending', tone: nodePending && st==='ready-for-human' ? 'warn' : VERDICT[st]?.[0] || 'warn', win, facts },
    };
  }
  /* A review running right now: the agents we know of (or the ones the profile will start), growing. */
  function liveStory() {
    const ev = S.liveEv || [];
    const last = (type, key, id) => ev.filter((e) => e.type === type && e[key] === id).pop();
    const ids = [...new Set(ev.filter((e) => e.type === 'candidate').map((e) => e.id))];
    const list = ids.length ? ids : Array.from({ length: EXPECT[S.profile] ?? 2 }, (_, i) => `C${i + 1}`);
    const agents = list.slice(0, 3).map((id, i) => {
      const st = last('candidate', 'id', id)?.status || 'pending', r = last('result', 'version', id);
      return { id, model: '…', strategy: st === 'built' ? 'version ready' : 'rebuilding from the ticket', color: COL.cands[i], built: !['failed', 'timeout', 'empty'].includes(st), fail: CAND[st] || st, tests: r ? { ok: r.status === 'passed', ran: r.ran ?? 0 } : null, here: true, files: [], decisions: 0 };
    });
    const orig = last('result', 'version', 'original'), part = agents.filter((a) => a.built);
    return {
      live: true, agents, prTests: orig ? { ok: orig.status === 'passed', ran: orig.ran ?? 0 } : null,
      prFiles: filesFor(S.plan?.files || S.run?.brief?.files, F.vers?.regions, false), checks: [], atkOut: [],
      roots: (() => { const c = ev.filter((e) => e.type === 'contract').pop(); return Array.isArray(c?.expectations) ? c.expectations.map((x) => `${x.id || ''} ${cut(x.behavior || '', 20)}`) : []; })(),
      j1: part.length >= 2 ? { a: part[0].id, b: part[1].id, lines: [], badgeAt: 9 } : null, j2: { lines: [] },
      atk: ev.some((e) => e.type === 'attack') ? { model: '…' } : null, prOk: null, consOk: null, spot: spotSummary(F.spotRaw, []), fixFrom: null,
      verdict: { score: null, label: 'Reviewing', tone: 'warn', win: 'none', facts: [] },
    };
  }

  /* ── The timeline: branches (world space, growing in time), bubbles riding their tips, lines, camera ── */
  function compile(s, W, H) {
    const br = {}, order = [], bub = {}, lines = [];
    const add = (o) => { br[o.id] = o; order.push(o); return o; };
    const B = (id, o) => (bub[id] = { id, r0: 8, segs: [id], wins: [], colors: [], names: [], badges: [], die: null, ...o });
    const ys = {}; s.agents.forEach((a, i) => (ys[a.id] = -60 + i * 120));
    const yA = -60 + Math.max(1, s.agents.length) * 120;
    const built = s.agents.filter((a) => a.built), part = built.filter((a) => a.here !== false);
    const status = [[0, s.spot ? `Review · ${s.spot.where}` : 'Review · agents rebuild the change from the base']];
    let cur = 0;
    const speak = (who, text, role) => { const d = speakMs(text); const L = { who, text, role, t0: cur, t1: cur + d }; lines.push(L); cur += d + 160; return L; };

    add({ id: 'PR', pts: [[0, 0], [150, -180], [900, -180]], color: COL.PR, t0: 300, t1: 2000, w: 1.15, label: 'The PR · as written' });
    B('PR', { name: 'The PR', sub: 'as written', color: COL.PR });
    if (s.prTests) add({ id: 'PRs', pts: [[620, -180], [700, -232]], color: COL.PR, t0: 1600, t1: 2300, spur: s.prTests });
    const arrive = {};
    s.agents.forEach((a, i) => {
      const t0 = 1300 + i * 160, y = ys[a.id], label = `${a.id} · ${a.strategy || a.model}`;
      B(a.id, { name: a.id, sub: a.model, color: a.color });
      if (a.built && a.here !== false) {
        add({ id: a.id, pts: [[0, 0], [150, y], [520, y]], color: a.color, t0, t1: t0 + 2700, label });
        arrive[a.id] = t0 + 2700;
      } else if (a.built) { // rebuilt the change, but never touched this spot: it stays on its own branch
        add({ id: a.id, pts: [[0, 0], [150, y], [470, y]], color: a.color, t0, t1: t0 + 2500, label, dead: 'did not touch this spot', quiet: true });
        bub[a.id].die = t0 + 2600;
        status.push([t0 + 2500, `${a.id} did not touch this spot`]);
      } else {
        add({ id: a.id, pts: [[0, 0], [150, y], [400, y]], color: a.color, t0, t1: t0 + 2300, label, dead: a.fail });
        bub[a.id].die = t0 + 2400;
        status.push([t0 + 2300, `${a.id} · ${a.fail}`]);
      }
      if (a.built && a.tests) add({ id: a.id + 's', pts: [[330, y], [410, y + (i === 0 ? -50 : 50)]], color: a.color, t0: t0 + 1700, t1: t0 + 2400, spur: a.tests });
    });
    if (s.atk) status.push([2200, 'The attacker writes a test against the PR']);

    // Twigs and sub-twigs: what each branch is made of, sprouting as the branch grows past them.
    const tAt = (b, x, xEnd) => b.t0 + (Math.acos(1 - 2 * clamp01(x / xEnd)) / Math.PI) * (b.t1 - b.t0);
    const twig = (id, from, to, t0, dur, o) => add({ id, pts: [from, to], color: o.color, t0, t1: t0 + dur, w: o.w || 0.55, twig: true, dot: o.dot, tlabel: o.label || '', lpos: o.lpos || 'right' });
    (s.roots || []).slice(0, 5).forEach((label, k, arr) => twig('rt' + k, [0, 0], [-66, (k - (arr.length - 1) / 2) * 30], 150 + k * 110, 650, { color: '#8a8a92', dot: 'warn', label, lpos: 'left' }));
    (s.prFiles || []).forEach((f, i) => {
      const x = 175 + i * 125, t0 = tAt(br.PR, x, 900), e = [x + 46, -236];
      twig('pf' + i, [x, -180], e, t0, 600, { color: COL.PR, dot: f.tone, label: f.label });
      f.regions.forEach((r, k) => twig(`pf${i}r${k}`, e, [e[0] - 12 + k * 26, e[1] - 30 - (k % 2) * 16], t0 + 520 + k * 130, 420, { color: COL.PR, dot: r.tone, label: r.label, lpos: 'up', w: 0.45 }));
    });
    (s.checks || []).slice(0, 7).forEach((c, i) => { const x = 235 + i * 68; twig('ck' + i, [x, -180], [x + 34, -146], tAt(br.PR, x, 900) + 250, 520, { color: COL.PR, dot: c.tone, label: c.label, lpos: i % 2 ? 'down2' : 'down' }); });
    s.agents.forEach((a, i) => {
      const b = br[a.id]; if (!b) return;
      const y = ys[a.id], xEnd = b.pts[2][0], items = [...(a.files || []).map((x) => ({ label: x, dot: 'file' })), ...Array.from({ length: Math.min(3, a.decisions || 0) }, () => ({ label: '', dot: 'warn' }))].slice(0, 4);
      const xs = [200, 262, 430, 488];
      items.forEach((it, k) => { const x = xs[k]; if (x > xEnd - 30) return; const dir = k % 2 ? 1 : -1; twig(`ag${a.id}${k}`, [x, y], [x + 36, y + dir * 32], tAt(b, x, xEnd) + 120, 520, { color: a.color, dot: it.dot, label: it.label, lpos: dir < 0 ? 'right' : 'rightdown', w: 0.5 }); });
    });

    // First junction: the first two agents that wrote this spot compare their versions and converge.
    let J1 = null, consId = null, consColor = null, yCons = null, m1 = null;
    if (s.j1) {
      const A = s.j1.a, Bb = s.j1.b;
      J1 = [640, (ys[A] + ys[Bb]) / 2];
      let reach = 0;
      part.forEach((a) => { const o = add({ id: a.id + 'j', pts: [[520, ys[a.id]], J1], color: a.color, t0: arrive[a.id], t1: arrive[a.id] + 700 }); bub[a.id].segs.push(o.id); reach = Math.max(reach, o.t1); });
      J1.start = reach + 300; cur = J1.start + 250;
      status.push([reach - 400, `${A} and ${Bb} compare their versions`]);
      s.j1.lines.forEach(([w, text], i) => { if (!bub[w]) return; const L = speak(w, text, w === A ? 'up' : 'down'); if (i === s.j1.badgeAt) L.badge = true; });
      const badgeT = (lines.find((l) => l.badge) || { t0: cur }).t0;
      m1 = [cur, cur + 1000]; cur = m1[1]; J1.end = m1[1];
      consId = A; yCons = J1[1]; consColor = mix(bub[A].color, bub[Bb].color, 0.5);
      part.forEach((a) => {
        const u = bub[a.id];
        u.wins.push({ a: J1.start - 500, b: m1[1], dir: a.id === A ? -1 : 1, big: a.id === A || a.id === Bb, m: m1 });
        u.colors.push({ t: m1[0], dur: 900, color: consColor });
        if (a.tests) u.badges.push({ t0: badgeT, t1: m1[0] + 200, ok: a.tests.ok });
        if (a.id !== A) u.die = m1[1] - 60;
      });
      bub[A].names.push({ t: m1[0] + 500, name: part.map((a) => a.id).join(' + '), sub: 'converged' });
      status.push([m1[0], `${part.map((a) => a.id).join(' and ')} converge`]);
    } else if (part.length === 1) { consId = part[0].id; yCons = ys[consId]; consColor = part[0].color; }

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
        (s.atkOut || []).slice(0, 4).forEach((o, k) => { const x = 330 + k * 72; twig('ao' + k, [x, yA], [x + 34, yA + 34], tAt(br.A, x, 800), 520, { color: COL.ATK, dot: o.tone, label: o.label, lpos: 'down', w: 0.5 }); });
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
      if (!s.live) status.push([m2[0], win === 'PR' ? 'They agree: the PR holds up' : win === 'CONS' ? 'They agree: the PR needs changes' : 'No agreement: not enough evidence']);
      END = [J2[0] + 240, J2[1]];
      add({ id: 'T', pts: [J2, [END[0] - 31, END[1]]], color: finalColor, t0: m2[1] - 200, t1: m2[1] + 1300, w: 1.35 });
      bub[winner].segs.push('T'); bub[winner].die = br.T.t1 + 80;
      tv = br.T.t1;
    } else {
      END = [1140, -180];
      add({ id: 'T', pts: [[900, -180], [END[0] - 31, END[1]]], color: COL.PR, t0: 2300, t1: 3600, w: 1.35 });
      bub.PR.segs.push('T'); bub.PR.die = br.T.t1 + 80; tv = br.T.t1;
    }
    if (!s.live) status.push([tv, `Verdict · ${s.verdict.label}${s.verdict.score != null ? ` · ${s.verdict.score}/10` : ''}`]);
    status.sort((a, b) => a[0] - b[0]);

    // Camera: frame the growth, dive into each junction, end on the whole tree with room for the verdict.
    const sG = Math.min(W / 1050, (H - 150) / 700), sZ = Math.min(W / 470, H / 380);
    const minX = s.roots?.length ? -230 : -100, maxX = END[0] + 50, minY = -300, maxY = yA + (s.atkOut?.length ? 70 : 30), midY = (minY + maxY) / 2;
    const panel = W >= 760 ? 380 : 0; // the verdict card sits right of the ring (below it on a phone)
    const sF = Math.min((W - 80 - panel) / (maxX - minX), (H - (panel ? 200 : 400)) / (maxY - minY));
    const cam = [{ t: 0, start: true, s: sG * 1.7 }, { t: 1300, x: 400, y: midY, s: sG }];
    const push = (t, x, y, sc) => { if (t > cam[cam.length - 1].t + 60) cam.push({ t, x, y, s: sc }); };
    if (J1) { push(J1.start - 1200, 480, midY, sG); push(J1.start + 150, J1[0] + 70, J1[1], sZ); push(J1.end, J1[0] + 70, J1[1], sZ * 1.07); push(J1.end + 1300, 840, (J1[1] + J2[1]) / 2, sG * 1.08); }
    if (J2) { push(J2.start - 1300, 780, midY, sG); push(J2.start + 150, J2[0] + 70, J2[1], sZ); push(J2.end, J2[0] + 70, J2[1], sZ * 1.07); }
    push(tv + 900, (minX + maxX) / 2 + panel / 2 / sF, midY + (panel ? 0 : (H / 2 - 200) / sF), sF);
    const hold = J1 ? J1.start - 1400 : J2 ? J2.start - 1700 : tv - 600; // a live review waits here for its result
    return { br, order, bub: Object.values(bub), lines, status, cam, END, tv, end: tv + 1400, hold, maxY };
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
        mk('text', { x: 16, y: 4, class: 'fcap' }, b.mark).textContent = `${b.spur.ran} tests`;
        b.tip = mk('circle', { r: 3.2, fill: b.color, opacity: 0 }, top);
      }
      if (b.dead) { b.cap = mk('text', { class: 'fcap', opacity: 0 }, top); b.cap.textContent = b.quiet ? b.dead : `✕ ${b.dead}`; }
      if (b.twig) {
        b.glow.setAttribute('stroke-opacity', 0);
        b.mark = mk('g', { class: 'ftw', opacity: 0 }, top);
        mk('circle', { r: 3.6, fill: TONE[b.dot] || TONE.no }, b.mark);
        if (b.tlabel) {
          const L = { right: [8, 3.5, 'start'], rightdown: [8, 8, 'start'], left: [-8, 3.5, 'end'], up: [0, -8, 'middle'], down: [0, 15, 'middle'], down2: [0, 27, 'middle'] }[b.lpos] || [8, 3.5, 'start'];
          b.markT = mk('text', { x: L[0], y: L[1], 'text-anchor': L[2] }, b.mark); b.markT.textContent = b.tlabel;
        }
        b.tip = mk('circle', { r: 2.6, fill: b.color, opacity: 0 }, top);
      }
    }
    // Branch names above every twig and dot, with a halo of the background (.flab): nothing crosses a name.
    for (const b of tl.order) if (b.lab) top.appendChild(b.lab);
    tl.baseDot = mk('circle', { r: 7, fill: F.spotRaw ? PAL.bad : COL.PR }, top);
    tl.baseLab = mk('text', { class: 'fcap', 'text-anchor': 'middle' }, top); tl.baseLab.textContent = F.spotRaw ? `${F.spotRaw.file}:${F.spotRaw.start}` : 'base + ticket';
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
    renderCard();
  }

  /* ── The verdict card: the result, then where you sign ── */
  const canApprove = () => { const b = S.run?.brief; return !!b && (!b.graphReview || (!b.graphReview.scope.partial && b.graphReview.scope.denominator.every(n=>b.graphReview.nodes.some(v=>v.id===n.id && v.status==='verified')))) && b.version >= 2 && b.verdict?.status === 'ready-for-human' && !b.rules.fired.some((r) => HARD.includes(r.id)); };
  function renderCard() {
    const s = F.story; if (!s) return;
    if (s.node) return renderNodeCard(s);
    const v = s.verdict, run = S.run, so = !s.live && run?.signoff;
    const chip = so ? (so.decision === 'aprobar' ? ['ok', 'Signed'] : ['bad', 'Sent back']) : [v.tone, v.label];
    const H = [`<div class="fvk">${esc(s.spot ? s.spot.where : 'Review')}</div>
      <div class="fvs"><span class="fvn">${v.score ?? '–'}<small>/10</small></span><span class="fchip" style="background:${PAL[chip[0]] || PAL.warn}">${esc(chip[1])}</span></div>`];
    if (!s.live && run?.brief?.graphReview) { // a review sent from the graph: what the tests back, function by function
      const gr = run.brief.graphReview, T = { verified: ['ok', 'backed by tests'], failed: ['bad', 'fails a test'], pending: ['warn', 'not backed yet'] };
      const name = (id) => S.math?.nodes?.find((x) => x.id === id)?.name || id.split('::').pop().replace(/\/\d+#\d+$/, '');
      const order = ['failed', 'pending', 'verified'], list = [...gr.nodes].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
      H.push(`<div class="fvh dim">${gr.nodes.length < gr.scope.denominator.length ? 'Selected scope' : 'Whole change'} · ${gr.nodes.filter((n) => n.status === 'verified').length} of ${gr.nodes.length} backed by tests</div>`
        + list.slice(0, 4).map((n) => `<p class="fvl"><i style="background:${PAL[(T[n.status] || T.pending)[0]]}"></i><span>${esc(name(n.id))} <em>${(T[n.status] || T.pending)[1]}</em></span></p>`).join('')
        + (list.length > 4 ? `<p class="fnote">and ${list.length - 4} more</p>` : '')
        + '<p class="fnote">The score covers this scope only. It is not the odds that the change is right.</p>');
    }
    if (!s.live && run?.brief?.verdict) {
      const b=run.brief, j=b.verdict;
      H.push(`<details class="fnote"><summary>Why this score · evidence and limits</summary><p>${esc(j.score?.explanation || '')}</p><ul>${(j.score?.components || []).map(c=>`<li>${esc(c.label)}: ${c.earned}/${c.max}. ${esc(c.reason)}</li>`).join('')}</ul><ul>${(j.pending || []).map(p=>`<li>Pending: ${esc(p)}</li>`).join('')}</ul><ul>${(j.auditWarnings || []).map(p=>`<li>${esc(p)}</li>`).join('')}</ul><p>${esc(j.semantic?.explanation || '')}</p></details>`);
      H.push(`<details class="fnote"><summary>All alternatives · ${b.candidates?.length || 0}</summary><ul>${(b.candidates || []).map(c=>`<li>${esc(c.id)} · ${esc(modelName(c.model))} · ${esc(c.status)} · Entire: ${esc(c.checkpoint?.status || 'not captured')}${c.error?' · '+esc(c.error):''}</li>`).join('')}</ul></details>`);
      H.push(`<p class="fnote">${esc(PROFILE[b.budget?.profile]?.[0] || b.budget?.profile || '')} · ${secs(b.budget?.elapsedMs || 0)} · ${Number(b.budget?.tokens || 0).toLocaleString()} tokens${b.budget?.usageIncomplete?' (usage incomplete)':''}</p>`);
    }
    if (!s.live && run?.brief?.repair) { const r=run.brief.repair; H.push(`<p class="fnote">Repair: ${esc(r.status)} · ${esc(r.reason || r.summary || '')}</p>`); if(r.patch) H.push(`<a class="cta ghost" download href="/api/projects/${encodeURIComponent(S.pid)}/runs/${encodeURIComponent(run.id)}/artifact?name=${encodeURIComponent(r.patch)}">Download proposed patch</a>`); }
    if (s.spot?.text) H.push(`<p class="fvl"><i style="background:${PAL[s.spot.tone] || PAL.no}"></i>${esc(s.spot.text)}</p>`);
    if (F.code && F.card !== 'sign') H.push(`<pre class="fcode">${F.code}</pre>`);
    if (F.fix && !so) H.push(`<div class="fvh">The fix · ${esc(F.fix.from)}'s version</div><pre class="fcode">${F.fix.html}</pre>`);
    if (so) {
      const sv = run.signed || {};
      H.push(`<div class="fdone"><b>${so.decision === 'aprobar' ? 'Accepted' : 'Sent back'} by ${esc(so.signer)}</b><span>${new Date(so.ts).toLocaleString('en-GB')}</span></div>`);
      if (so.decision === 'aprobar' && sv.commands?.length) H.push(`<div class="fcopy"><button type="button" id="fCopy">Copy</button><pre id="fcmd">${esc(sv.commands.join('\n'))}</pre></div><p class="fnote">Katse never merges. You do.</p>`);
    } else if (F.card === 'sign') {
      const b = run.brief, ap = F.signMode === 'aprobar';
      if (ap) for (const q of b.questions) H.push(`<div class="fq"><p>${esc(q.text)}</p><div class="fopts">${q.options.map((o) => `<button type="button" class="fopt${F.answers[q.id] === o ? ' on' : ''}" data-q="${esc(q.id)}" data-o="${esc(o)}">${esc(OPTION[o] || o)}</button>`).join('')}</div></div>`);
      if (ap && b.residue.items.length) H.push(`<label class="fck"><input type="checkbox" id="fckRes"><span>I read the ${b.residue.lines} lines left for me (the red spots)</span></label>`);
      if (ap) H.push(`<label class="fck"><input type="checkbox" id="fckNot"><span>I reviewed the ${b.notChecked.length} things that were not checked</span></label>`);
      H.push(`<input class="fin" id="fsigner" placeholder="Your name" autocomplete="name" value="${esc(store.get('katse.signer') || '')}">`);
      H.push(ap ? '<textarea class="fin" id="frisk" rows="2" placeholder="The risk you accept, in your words"></textarea>' : `<textarea class="fin" id="frisk" rows="2" placeholder="Why it goes back (optional)">${F.fix ? esc(`Use ${F.fix.from}'s version: ${F.fix.patch}.`) : ''}</textarea>`);
      H.push(`<div class="fvb"><button class="cta" id="fGo">${ap ? 'Accept & sign' : 'Send back'}</button><button class="cta ghost" id="fCancel">Back</button></div><div class="ferr" id="fserr"></div>`);
    } else {
      H.push(`<ul>${v.facts.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`);
      const ok = canApprove();
      H.push(`<div class="fvb">${ok ? '<button class="cta" id="fSign">Sign</button>' : ''}<button class="cta${ok ? ' ghost' : ''}" id="fSend" ${s.live?'disabled':''}>${s.live?'Review in progress':F.fix ? 'Send back with the fix' : 'Send back'}</button></div>`);
    }
    CARD.innerHTML = H.join('');
    if ($('fSign')) $('fSign').onclick = () => { F.card = 'sign'; F.signMode = 'aprobar'; renderCard(); };
    if ($('fSend')) $('fSend').onclick = () => { F.card = 'sign'; F.signMode = 'devolver'; renderCard(); };
    if ($('fCancel')) $('fCancel').onclick = () => { F.card = 'verdict'; renderCard(); };
    if ($('fGo')) $('fGo').onclick = () => submit(F.signMode);
    CARD.querySelectorAll('.fopt').forEach((x) => (x.onclick = () => {
      F.answers[x.dataset.q] = x.dataset.o;
      CARD.querySelectorAll(`.fopt[data-q="${CSS.escape(x.dataset.q)}"]`).forEach((y) => y.classList.toggle('on', y === x));
    }));
    if ($('fCopy')) $('fCopy').onclick = async () => {
      try { await navigator.clipboard.writeText($('fcmd').textContent); $('fCopy').textContent = 'Copied'; } catch { $('fCopy').textContent = 'Select and copy'; }
      setTimeout(() => $('fCopy') && ($('fCopy').textContent = 'Copy'), 1400);
    };
  }
  async function submit(decision) {
    const run = S.run, b = run?.brief, err = $('fserr');
    if (!b || F.story.live) return;
    const signer = $('fsigner').value.trim(); store.set('katse.signer', signer);
    const risk = ($('frisk')?.value || '').trim(), residueOk = !!$('fckRes')?.checked, notOk = !!$('fckNot')?.checked;
    const answers = { ...F.answers }, open = b.questions.filter((q) => !answers[q.id]).length;
    // The same rules the server enforces, said before the round trip.
    const problem = !signer ? 'Write your name: a person signs, not the tool.'
      : decision !== 'aprobar' ? ''
      : !canApprove() ? 'This change cannot be accepted: checks are missing or it fails. Send it back.'
      : open ? `Answer the ${open === 1 ? 'open question' : `${open} open questions`} first.`
      : b.residue.items.length && !residueOk ? 'Confirm that you read the lines left for you.'
      : !notOk ? 'Confirm that you reviewed what was not checked.'
      : risk.length < 20 ? 'Describe the risk you accept, in your own words (one sentence at least).' : '';
    if (problem) { err.textContent = problem; return; }
    err.textContent = ''; $('fGo').disabled = true;
    try {
      const r = await api(`/projects/${S.pid}/runs/${run.id}/signoff`, { body: { signer, decision, answers, residualRisk: risk, checks: { residue: residueOk, notChecked: notOk } } });
      run.signoff = r.signoff; run.signed = r; F.card = 'verdict';
      if (F.open && S.run === run) renderCard();
      renderBar(); reloadPRs().catch(() => {});
    } catch (e) { if ($('fserr')) $('fserr').textContent = english(e.message); if ($('fGo')) $('fGo').disabled = false; }
  }

  /* ── Frame ── */
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
  /* Agents never sit on top of each other. Two grown bubbles that overlap (or nearly: the goo filter would fuse
     them) are pushed apart along the line between them, both by half the overlap; bubbles at the same point
     split vertically in a fixed order, so the picture does not jitter. Small tips on the branches stay put:
     they mark where a branch is. A few rounds settle three or four bubbles. */
  function separate(list) {
    const big = list.filter((u) => u.sr > 14);
    if (big.length < 2) return;
    const gap = Math.max(16, Math.min(24, Math.max(...big.map((u) => u.sr)) * 0.3));
    for (let round = 0; round < 6; round++) {
      let moved = false;
      for (let i = 0; i < big.length; i++) for (let j = i + 1; j < big.length; j++) {
        const a = big[i], b = big[j];
        let dx = b.sx - a.sx, dy = b.sy - a.sy, d = Math.hypot(dx, dy);
        const need = a.sr + b.sr + gap;
        if (d >= need) continue;
        if (d < 0.5) { dx = 0; dy = 1; d = 1; } // same spot: the later agent goes below
        const push = (need - d) / 2, ux = dx / d, uy = dy / d;
        a.sx -= ux * push; a.sy -= uy * push; b.sx += ux * push; b.sy += uy * push;
        moved = true;
      }
      if (!moved) break;
    }
  }
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
      if (b.twig) {
        const end = b.pts[1], [x, y] = P(end[0], end[1]);
        moveG(b.mark, x, y); b.mark.setAttribute('opacity', sm((t - b.t1 + 80) / 300).toFixed(2));
        if (b.markT) b.markT.setAttribute('opacity', sm((c.s - 0.62) / 0.2).toFixed(2)); // small tree: dots only, labels would pile up
        if (p > 0 && p < 1) { const q = b.el.getPointAtLength(b.len * e), [tx, ty] = P(q.x, q.y); b.tip.setAttribute('cx', tx); b.tip.setAttribute('cy', ty); b.tip.setAttribute('opacity', 1); } else b.tip.setAttribute('opacity', 0);
      }
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
      else if (F.live && t >= tl.hold - 1) r += Math.sin(now / 500 + y * 0.05) * 1.6; // waiting for the agents: the tips breathe
      let col = u.color; for (const k of u.colors) col = mix(col, k.color, sm((t - k.t) / k.dur));
      Object.assign(u, { sx: x, sy: y, sr: Math.max(0, r), col, on: true });
    }
    separate(tl.bub.filter((u) => u.on));
    for (const u of tl.bub) {
      if (!u.on) continue;
      const { sx: x, sy: y, sr: r, col } = u;
      u.el.setAttribute('cx', x.toFixed(1)); u.el.setAttribute('cy', y.toFixed(1)); u.el.setAttribute('r', r.toFixed(1)); u.el.setAttribute('fill', col);
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
      u.nm = nm;
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
    const rk = F.live ? 0 : sm((t - tl.tv + 150) / 500);
    moveG(tl.ring, ex, ey); tl.ring.setAttribute('opacity', rk.toFixed(2)); tl.ringC.setAttribute('r', (30 * (0.6 + 0.4 * rk)).toFixed(1));
    const von = !F.live && t >= tl.tv + 250;
    if (CARD.classList.contains('on') !== von) CARD.classList.toggle('on', von);
    if (von) {
      const cw = CARD.offsetWidth, ch = CARD.offsetHeight;
      CARD.style.left = (F.phone ? 16 : Math.min(W - cw - 16, ex + 50)) + 'px';
      CARD.style.top = (F.phone ? Math.min(H - ch - 16, Math.max(ey + 52, P(0, tl.maxY)[1] + 16)) : Math.max(84, Math.min(H - ch - 110, ey - ch / 2))) + 'px';
    }
    let st = '';
    if (F.live) st = F.mode === 'node' ? `Three agents rebuild ${F.nodeName} blind · ${secs(Date.now() - F.nodeT0)}` : S.es ? `${S.stage} · ${secs(Date.now() - S.t0)}` : 'Starting the review…';
    else for (const [t0, txt] of tl.status) if (t >= t0) st = txt;
    if (st !== F.stat) { F.stat = st; $('fstat').textContent = st; }
  }

  function frame(now) {
    F.raf = requestAnimationFrame(frame);
    const dt = F.last ? Math.min(64, now - F.last) : 16; F.last = now;
    if (F.playing && F.tl) {
      if (F.live) F.t = Math.min(F.tl.hold, F.t + dt * (F.t < 1400 ? 1 : 0.3)); // grows, then waits for the real result
      else { F.t += dt; if (F.t >= F.tl.end) { F.t = F.tl.end; F.playing = false; paintCtl(); } }
    }
    if (F.tl) draw(F.t, now);
  }
  function paintCtl() { $('fskip').hidden = F.live; $('fskip').textContent = F.playing ? 'Skip' : 'Replay'; }
  $('fskip').onclick = () => { if (!F.tl || F.live) return; if (F.playing) { F.t = F.tl.end; F.playing = false; } else { F.t = 1300; F.playing = true; } paintCtl(); };
  $('fclose').onclick = () => closeTree();

  /* ── Data for the spot and the fix ── */
  function findZone(q) {
    const s = String(q || '').toLowerCase().trim(); if (!s) return null;
    const zones = [...G.nodes.values()].filter((n) => n.kind === 'zone');
    const m = s.match(/(?:([\w.-]+\.\w+)\s*)?:?\s*(\d+)/);
    if (m) { const n = +m[2]; const pool = zones.filter((z) => !m[1] || z.file.toLowerCase().includes(m[1])); return pool.sort((a, b) => Math.abs(a.start - n) - Math.abs(b.start - n))[0] || null; }
    return zones.find((z) => z.file.toLowerCase().includes(s)) || null;
  }
  /* The run's versions (every region the PR changed, and which agents also wrote it); without a run, the PR's own. */
  async function loadVersions(real) {
    try {
      const r = S.run, req = api(real ? `/projects/${S.pid}/runs/${r.id}/versions` : `/projects/${S.pid}/versions?pr=${encodeURIComponent(S.cur.id)}`);
      req.catch(() => {});
      return await Promise.race([req, new Promise((_, no) => setTimeout(() => no(new Error('slow')), 1500))]);
    } catch { return null; }
  }
  /* The clicked spot: its code, and which agents also wrote it. */
  function spotFrom(zone, data, real) {
    F.code = '';
    if (!zone) return null;
    const spot = { file: zone.file, start: zone.start, tone: zone.tone, info: String(zone.info || '').split(' · ').slice(1).join(' · ') || zone.info, who: null };
    const reg = (data?.regions || []).filter((x) => base(x.file) === zone.file).sort((a, b) => Math.abs(a.start - zone.start) - Math.abs(b.start - zone.start))[0];
    if (reg) {
      if (real) spot.who = reg.who;
      F.code = [...reg.removed.slice(0, 3).map((x) => `<span class="r">- ${esc(x.trim())}</span>`), ...reg.added.slice(0, 4).map((x) => `<span class="a">+ ${esc(x.trim())}</span>`)].join('\n');
    }
    return spot;
  }
  /* When the review asks for changes, the fix is the version the agents agreed on: its patch, at this spot. */
  async function loadFix(s, seq) {
    F.fix = null;
    if (!s.fixFrom?.patch || !S.run) return;
    try {
      const res = await fetch(`/api/projects/${S.pid}/runs/${S.run.id}/artifact?name=${encodeURIComponent(s.fixFrom.patch)}`);
      if (!res.ok || seq !== F.seq) return;
      const files = (await res.text()).split(/^diff --git /m).slice(1);
      const f = (F.spotRaw && files.find((x) => x.split('\n')[0].includes(F.spotRaw.file))) || files[0];
      if (!f || seq !== F.seq) return;
      const lines = f.split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l)).slice(0, 8);
      F.fix = { from: s.fixFrom.id, patch: s.fixFrom.patch, html: lines.map((l) => `<span class="${l[0] === '+' ? 'a' : 'r'}">${esc(l.slice(0, 96))}</span>`).join('\n') };
      renderCard();
    } catch { /* no fix to show */ }
  }

  /* ── One node of the mathematical graph, reviewed alone (server/math/nodereview.js) ──
     Three agents rebuild that one function from the requirement without seeing the PR; mathematics compares
     the rebuilds with it; a judge may only argue with sentences quoted from the requirement. Seconds, not
     minutes. The tree is the same story, told for one function. */
  const NODE_TONE = { reproduced: 'ok', differs: 'bad', unclear: 'warn' };
  const NODE_WORD = { reproduced: 'Reproduced', differs: 'Differs', unclear: 'You decide' };
  const NODE_STRATEGY = ['To the letter', 'Edge cases first', 'Smallest change'];
  function nodeStory(node, r) {
    const d = node.m, uniq = (a) => [...new Set(a)];
    const agents = (r ? r.agents : NODE_STRATEGY.map((x, i) => ({ id: 'A' + (i + 1) }))).slice(0, 3).map((a, i) => ({
      id: a.id, model: r ? modelName(a.model) : '…', strategy: a.strategy || NODE_STRATEGY[i], color: COL.cands[i], built: r ? !!a.ok : true, fail: r && !a.ok ? 'could not rebuild it' : null,
      tests: null, summary: a.summary || '', here: true, decisions: 0, same: !!a.equivalent,
      files: r && a.ok ? [a.equivalent ? 'same tokens' : a.similarity != null ? `${Math.round(a.similarity * 100)}% alike` : 'different'] : [],
    }));
    const built = agents.filter((a) => a.built), says = r?.says || {};
    const v = r?.verdict, win = v === 'reproduced' ? 'PR' : v === 'differs' ? 'CONS' : 'none';
    const diff = r?.differences?.find((x) => x.grounded && x.right === 'replica') || r?.differences?.[0];
    const L2 = [];
    if (r && built.length) {
      L2.push(['PR', cut(says.PR || 'The change, as written.')]);
      if (v === 'reproduced') L2.push(['CONS', cut(r.explanation || 'We wrote the same thing from the requirement.'), 'badge'], ['CONS', 'It holds up. Take it.']);
      else if (diff) {
        L2.push(['CONS', cut(`${diff.input}: you give ${diff.pr}, we give ${diff.other}.`, 120), 'badge']);
        if (diff.rule) L2.push(['CONS', cut(`The requirement says: “${diff.rule}”`, 130)]);
        L2.push(win === 'CONS' ? ['PR', 'Fair. I need that change.'] : ['PR', 'The requirement does not say. A person decides.']);
      } else L2.push(['CONS', cut(r.explanation || 'We could not settle it.')]);
    }
    const facts = !r ? [] : [
      `${built.length} of ${agents.length} agents rebuilt it blind from ${String(r.requirement?.label || 'the requirement').toLowerCase()}`,
      ...built.map((a) => `${a.id} · ${a.strategy} · ${a.files[0] || ''}`),
      r.differences.length ? `${r.differences.length} behavioural ${r.differences.length === 1 ? 'difference' : 'differences'} · ${r.differences.filter((x) => x.grounded).length} decided by a quoted rule` : built.length ? 'No behavioural difference found' : null,
      r.decision?.status === 'used' ? `Decision model · ${r.decision.choice} · ${Math.round(r.decision.confidence * 100)}% confident` : null,
    ].filter(Boolean);
    return {
      node: true, result: r || null, live: !r, agents, prTests: null,
      j1: built.length >= 2 ? { a: built[0].id, b: built[1].id, lines: r ? [[built[0].id, cut(says[built[0].id] || built[0].summary)], [built[1].id, cut(says[built[1].id] || built[1].summary)]].filter((l) => l[1]) : [], badgeAt: 9 } : null,
      j2: { lines: L2 },
      prFiles: [{ label: cut(base(d.file), 18), tone: 'file', regions: [{ label: ':' + d.start, tone: r ? NODE_TONE[v] : node.tone === 'ctx' ? 'no' : node.tone }] }],
      checks: (d.evidence || []).slice(0, 5).map((e) => ({ label: cut(`${e.label} ${e.value}`, 24), tone: e.tone })),
      roots: r ? uniq(r.agents.flatMap((a) => a.rules || [])).slice(0, 4).map((x) => cut(x, 28)) : [],
      atkOut: [], atk: null, prOk: r ? (v === 'reproduced' ? true : v === 'differs' ? false : null) : null, consOk: r && v !== 'unclear' ? true : null,
      spot: { where: `${base(d.file)}:${d.start}`, text: r ? r.explanation : d.claim, tone: r ? NODE_TONE[v] : node.tone === 'bad' ? 'bad' : 'warn' },
      fixFrom: r?.fix ? { id: r.fix.from } : null,
      verdict: { score: null, label: r ? NODE_WORD[v] : 'Reviewing', tone: r ? NODE_TONE[v] : 'warn', win, facts },
    };
  }
  function renderNodeCard(s) {
    const r = s.result; if (!r) { CARD.innerHTML = ''; return; }
    const built = s.agents.filter((a) => a.built), v = r.verdict, id = r.id;
    const against = new Set(r.differences.filter((x) => x.grounded && x.right === 'replica').map((x) => x.replica));
    const agree = v === 'reproduced' ? built.length : v === 'differs' ? Math.max(0, built.length - Math.max(1, against.size)) : null;
    const d = r.differences.find((x) => x.grounded && x.right === 'replica') || r.differences[0];
    const H = [`<div class="fvk">${esc(s.spot.where)} · ${esc(r.node.name)}</div>
      <div class="fvs"><span class="fvn">${agree ?? '?'}<small>/${built.length}</small></span><span class="fvcap">agents wrote<br>what the PR did</span><span class="fchip" style="background:${PAL[NODE_TONE[v]]}">${NODE_WORD[v]}</span></div>
      <p class="fvl"><i style="background:${PAL[NODE_TONE[v]]}"></i>${esc(r.explanation || (v === 'reproduced' ? 'The agents wrote the same function.' : 'The agents could not settle it.'))}</p>`];
    if (d && v !== 'reproduced') H.push(`<div class="fdiff"><code>${esc(d.input)}</code><div><span>The PR</span><b>${esc(d.pr)}</b></div><div><span>${esc(d.replica || 'Agents')}</span><b>${esc(d.other)}</b></div>${d.rule ? `<p>${d.grounded ? '' : 'Not found in the requirement: '}“${esc(d.rule)}”</p>` : '<p>The requirement does not decide this.</p>'}</div>`);
    if (r.fix) H.push(`<div class="fvh">The fix · ${esc(r.fix.from)}'s version</div><pre class="fcode">${r.fix.diff.map((x) => `<span class="${x.t === '+' ? 'a' : 'r'}">${x.t} ${esc(x.l.slice(0, 96))}</span>`).join('\n')}</pre>`);
    H.push(`<ul>${s.verdict.facts.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`);
    H.push(`<div class="fvb">${v === 'reproduced' ? '<button class="cta" id="fnDone">Done</button>' : r.fix ? '<button class="cta" id="fnCopy">Copy the fix</button><button class="cta ghost" id="fnKeep">Keep the PR\'s</button>' : '<button class="cta" id="fnKeep">I read it: it is right</button><button class="cta ghost" id="fnDone">Leave it open</button>'}</div><button type="button" class="fnagain" id="fnAgain">Ask the agents again</button>`);
    CARD.innerHTML = H.join('');
    if ($('fnDone')) $('fnDone').onclick = () => closeTree();
    if ($('fnKeep')) $('fnKeep').onclick = async () => { await markNode(id, 'read'); closeTree(); };
    if ($('fnCopy')) $('fnCopy').onclick = async () => { try { await navigator.clipboard.writeText(r.fix.code); $('fnCopy').textContent = 'Copied'; } catch { showText(`The fix · ${r.fix.from}'s version`, r.fix.code); } };
    if ($('fnAgain')) $('fnAgain').onclick = () => { const n = G.nodes.get(id); if (n) openNode(n, true); };
  }
  async function openNode(node, force) {
    const seq = ++F.seq; clearTimeout(F.hideT);
    F.origin = toScreen(node.x, node.y);
    Object.assign(F, { mode: 'node', nodeName: node.label, nodeT0: Date.now(), zone: null, vers: null, code: '', fix: null, card: 'verdict', answers: {}, stat: '', spotRaw: null, live: true, open: true });
    G.pin = null; G.hover = null; $('tip').classList.remove('on');
    $('g').style.transformOrigin = `${F.origin[0]}px ${F.origin[1]}px`;
    $('full').classList.add('infix'); sec.hidden = false; void sec.offsetWidth; sec.classList.add('on');
    F.story = nodeStory(node, null); build();
    F.t = RM ? F.tl.hold : 0; F.playing = true; paintCtl();
    if (!F.raf) { F.last = 0; F.raf = requestAnimationFrame(frame); }
    const pid = S.pid, pr = S.cur.id;
    let r;
    try { r = await api(`/projects/${pid}/math/review`, { body: { pr, node: node.id, force: !!force } }); }
    catch (e) { if (seq === F.seq && F.open) { closeTree(); renderBar(e.message); } return { started: false, error: e.message }; }
    if (r.marks && S.cur?.id === pr && S.pid === pid) { S.marks = r.marks; if (!$('full').hidden) renderGraph(graphModel()); } // the node is repainted under the tree
    if (seq !== F.seq || !F.open) return null;
    F.live = false; F.story = nodeStory(G.nodes.get(node.id) || node, r); build();
    if (RM || r.cached) { F.t = r.cached && !RM ? Math.max(F.t, 1300) : F.tl.end; }
    F.playing = !RM; paintCtl();
    return info();
  }

  /* ── Open / close ── */
  async function openTree(target = {}) {
    if ($('full').hidden || !S.cur) return null;
    /* One function of the mathematical graph is reviewed alone by the agents (openNode): seconds, any language.
       focusNodes sends the chosen functions through the executable pipeline instead (server/graph-review.js). */
    if (target.node?.kind === 'sym' && S.math && !target.focusNodes) return openNode(target.node, target.force);
    const focusNodes = target.focusNodes || null;
    const seq = ++F.seq; clearTimeout(F.hideT); F.mode = 'full';
    const zone = target.node?.kind === 'zone' ? target.node : findZone(target.query);
    const n = zone || target.node || G.nodes.get('pr');
    F.origin = n ? toScreen(n.x, n.y) : [innerWidth / 2, innerHeight / 2];
    Object.assign(F, { zone, vers: null, code: '', fix: null, card: 'verdict', signMode: 'aprobar', answers: {}, stat: '', story: null, tl: null });
    const b = S.run?.brief, stale = !!(b && S.cur.sha && b.pr?.head && !b.pr.head.startsWith(S.cur.sha));
    const real = b?.version >= 2 && !stale && !S.es && !focusNodes && !target.force;
    F.live = !real; F.open = true;
    G.pin = null; G.hover = null; $('tip').classList.remove('on');
    $('g').style.transformOrigin = `${F.origin[0]}px ${F.origin[1]}px`;
    $('full').classList.add('infix'); sec.hidden = false; void sec.offsetWidth; sec.classList.add('on');
    $('fstat').textContent = real ? 'Review' : 'Starting the review…';
    if (!F.raf) { F.last = 0; F.raf = requestAnimationFrame(frame); }
    F.vers = await loadVersions(real);
    if (seq !== F.seq || !F.open) return null;
    F.spotRaw = spotFrom(zone, F.vers, real);
    F.story = real ? realStory(b, F.spotRaw) : liveStory();
    build();
    const signed = real && !!S.run.signoff;
    F.t = RM || signed ? F.tl.end : 0; F.playing = !(RM || signed); paintCtl();
    if (real) loadFix(F.story, seq);
    else if (!S.es && !S.starting) {
      const ok = await verify(focusNodes);
      if (!ok && seq === F.seq) { closeTree(); return { started: false, error: 'The review could not start. The bar says why.' }; }
    }
    return info();
  }
  function closeTree(instant) {
    if (!F.open) return false;
    F.open = false; F.playing = false; F.seq++;
    $('full').classList.remove('infix'); sec.classList.remove('on'); CARD.classList.remove('on');
    clearTimeout(F.hideT);
    F.hideT = setTimeout(() => { if (!F.open) { sec.hidden = true; cancelAnimationFrame(F.raf); F.raf = 0; } }, instant ? 0 : 650);
    if (S.cur && !$('full').hidden) renderBar();
    return true;
  }
  /* Live: every candidate, attack or test result redraws the tree where it is. */
  function onEvent(e) {
    if (!F.open || !F.live || F.mode === 'node' || !F.tl || !['candidate', 'attack', 'result'].includes(e.type)) return;
    F.story = liveStory(); build();
  }
  /* The review finished: the tree goes on from where it waits, now with the real debate and verdict. */
  async function liveDone() {
    if (!F.open || !F.live || F.mode === 'node') return;
    const b = S.run?.brief, seq = F.seq;
    if (!(b?.version >= 2)) { closeTree(); return; }
    F.live = false;
    F.vers = await loadVersions(true);
    if (seq !== F.seq || !F.open) return;
    F.spotRaw = spotFrom(F.zone, F.vers, true);
    F.story = realStory(b, F.spotRaw); build();
    F.playing = true; paintCtl();
    loadFix(F.story, seq);
  }
  function info() {
    const s = F.story; if (!s) return { open: F.open, live: F.live };
    const who = (id) => F.tl?.bub.find((u) => u.id === id);
    return {
      live: s.live, spot: s.spot, playing: F.playing,
      agents: s.agents.map((a) => ({ id: a.id, model: a.model, strategy: a.strategy, rebuilt: a.built, wroteThisSpot: a.here, failure: a.fail, tests: a.tests ? `${a.tests.ok ? 'passed' : 'failed'} (${a.tests.ran} tests)` : null })),
      debates: (F.tl?.lines || []).map((l) => ({ who: who(l.who)?.names.at(-1)?.name || who(l.who)?.name || l.who, says: l.text })),
      verdict: s.live ? null : s.verdict, fixFrom: s.fixFrom?.id || null, signed: !!S.run?.signoff,
    };
  }
  let rz = 0;
  addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (F.open && F.story) build(); }, 150); });

  Object.assign(window, {
    openTree, closeTree, treeOpen: () => F.open, treeInfo: info, treeEvent: onEvent, treeLiveDone: liveDone,
    treeSkip: () => { if (!F.open || !F.tl || F.live) return false; F.t = F.tl.end; F.playing = false; paintCtl(); return true; },
    treeReplay: () => { if (!F.open || !F.tl || F.live) return false; F.t = 1300; F.playing = true; paintCtl(); return true; },
    treeEscape: () => (F.open ? closeTree() : false),
    treeSeek: (t) => { if (!F.open || !F.tl) return false; F.t = Math.max(0, Math.min(F.tl.end, t)); return { t: F.t, end: F.tl.end, verdictAt: F.tl.tv }; },
  });
})();
