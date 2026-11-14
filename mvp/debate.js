/* Katse · the agents' debate, told as a short story with bubbles that meet, argue and merge.
   A design preview: the data is a sample shaped like a real consensus run (server/consensus/run.js:
   agents; rounds with pair, winner, loser, kind and arguments; a verdict with groups). It is built from the
   open branch, so each branch always tells the same story. When the backend serves a run for the branch,
   debateFor() is the only piece that changes. Uses app.js globals: $, esc, mk, base, name, state, S, G,
   spring, RM, focusOn, focusPoint, zoomGraph. */
(() => {
  const D = { open: false, data: null, chs: [], ch: -1, chAt: 0, sub: -1, rs: null, agent: null, paused: 0, raf: 0, t: 0, B: [], msgs: [], hideT: 0 };
  const sec = $('debate'), blobs = $('dblobs'), labels = $('dlabels');
  const ROUND = 3600;

  /* ── Sample data, deterministic per branch ─────────────────────────── */
  function rng(seed) {
    let a = 0; for (const ch of String(seed)) a = (Math.imul(a, 31) + ch.charCodeAt(0)) | 0;
    return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  const PERSONAS = [['A', 'Precise', '#e3dcf4', 0.2, 0.8], ['B', 'Steady', '#cde4ee', 0.4, 0.9], ['C', 'Balanced', '#bfe3d0', 0.7, 0.95], ['D', 'Curious', '#f3e2a6', 1.0, 0.95], ['E', 'Bold', '#f2c6d9', 1.3, 1.0]];
  function groupsOf(rounds) {
    const par = {}; const find = (x) => { par[x] = par[x] ?? x; return par[x] === x ? x : (par[x] = find(par[x])); };
    PERSONAS.forEach(([id]) => find(id)); find('PR');
    rounds.forEach((d) => { if (d.kind !== 'hold') par[find(d.pair[1])] = find(d.pair[0]); });
    const g = {}; Object.keys(par).forEach((id) => (g[find(id)] = g[find(id)] || []).push(id));
    return Object.values(g).sort((x, y) => y.length - x.length);
  }
  /* The real review run (server/pipeline/complete.js): alternatives rebuilt from the base, their debate,
     attacks on the PR and the judge. Same shape as the sample, so the story plays the same way. */
  function realDebate(b) {
    const cut = (t, n = 130) => { const x = String(t || '').replace(/\s+/g, ' ').trim(); return x.length > n ? x.slice(0, n - 1) + '…' : x; };
    const ev = (v) => (b.evidence || []).filter((e) => e.version === v).pop();
    const COL = ['#cde4ee', '#e3dcf4', '#bfe3d0', '#f2c6d9'];
    const cands = (b.candidates || []).filter((c) => c.status !== 'duplicate').slice(0, 4);
    const nm = cands.map((c) => modelName(c.model));
    const agents = cands.map((c, i) => {
      const e = ev(c.id), m = nm[i], st = CAND[c.status] || c.status;
      return { id: c.id, name: nm.filter((x) => x === m).length > 1 ? `${c.id} ${m}` : m, color: COL[i % COL.length], role: 'solver', meta: `Alternative ${c.id} · rebuilt from the base without seeing the PR · ${m}`,
        subA: 'from the base', subB: `${st}${e ? ` · ${e.ran} tests` : ''}`, stats: [[e?.ran ?? '–', 'tests run'], [e?.status || '–', 'its suite'], [st, 'patch']] };
    });
    const orig = ev('original'), finds = b.verdict?.findings || [];
    agents.push({ id: 'PR', name: 'The PR', color: '#f5f5f7', role: 'advocate', meta: 'The change under review, as written', subA: 'as written', subB: orig ? `${orig.status} · ${orig.ran} tests` : '', stats: [[orig?.ran ?? '–', 'tests run'], [orig?.status || '–', 'its suite'], [finds.length, finds.length === 1 ? 'attack faced' : 'attacks faced']] });
    const atk = (b.attacks || [])[0];
    if (atk) agents.push({ id: 'ATK', name: 'Attacker', color: '#f2a99f', role: 'attacker', meta: `Writes tests to break the PR · ${modelName(atk.attacker)}${atk.modelFallback ? ' (stand-in model)' : ''}`, subA: 'attacks', subB: modelName(atk.attacker), quote: cut(atk.hypothesis, 220),
      stats: [[b.attacks.length, b.attacks.length === 1 ? 'attack' : 'attacks'], [b.attacks.filter((a) => a.status === 'admitted').length, 'admitted'], [finds.filter((f) => f.classification === 'confirmed-original').length, 'landed']] });
    const sc = b.verdict?.score?.value, judge = b.providers?.models?.review || 'carbon';
    agents.push({ id: 'JDG', name: 'Judge', color: '#f3e2a6', role: 'judge', meta: `Audits the contract and the evidence · ${modelName(judge)}`, subA: 'judges', subB: modelName(judge), quote: b.verdict?.semantic?.explanation ? cut(b.verdict.semantic.explanation.split(/(?<=\.)\s/)[0], 220) : null,
      stats: [[sc ?? '–', 'score / 10'], [(b.verdict?.pending || []).length, 'blockers'], [(b.contract?.expectations || []).length, 'expectations']] });
    const rounds = [];
    const deb = (Array.isArray(b.debate) ? b.debate : b.debate?.entries || []).filter((d) => d.status !== 'incomplete');
    for (const phase of ['proposals', 'results']) {
      const [x, y] = deb.filter((d) => (d.round || 'proposals') === phase);
      if (x && y && x.candidate !== y.candidate && agents.some((a) => a.id === x.candidate) && agents.some((a) => a.id === y.candidate)) {
        const say = (d) => cut(phase === 'results' ? d.revision || d.risk : d.risk || d.strength);
        rounds.push({ pair: [x.candidate, y.candidate], kind: 'talk', phase, arguments: { [x.candidate]: { argument: say(x) }, [y.candidate]: { argument: say(y) } } });
      }
    }
    if (atk) for (const f of finds) {
      const o = (f.outcomes || []).find((x) => x.version === 'original');
      const kind = f.classification === 'confirmed-original' ? 'convinced' : f.classification === 'refuted' ? 'hold' : 'talk';
      rounds.push({ pair: ['ATK', 'PR'], kind, winner: kind === 'convinced' ? 'ATK' : null, loser: kind === 'convinced' ? 'PR' : null, attack: f.attack,
        arguments: { ATK: { argument: cut(f.hypothesis) }, PR: { argument: !o ? 'Not run on the PR.' : o.outcome === 'passed' ? 'Passes on the PR: refuted.' : o.outcome === 'failed' ? 'Fails on the PR.' : 'Not run in time.' } } });
    }
    rounds.forEach((r, i) => (r.round = i + 1));
    const stv = b.verdict?.status, ids = agents.map((a) => a.id);
    const camp = stv === 'ready-for-human' ? ['PR', 'JDG'] : stv === 'request-changes' && atk ? ['ATK', 'JDG'] : ['JDG'];
    const groups = [camp, ...ids.filter((i) => !camp.includes(i)).map((i) => [i])];
    const label = VERDICT[stv]?.[1] || b.verdict?.label || 'Pending';
    const pend = (b.verdict?.pending || []).length;
    return {
      real: true, sample: false, runId: S.run?.id, agents, rounds, agreement: 0, pre: ids.map((i) => [i]),
      text: { agents: [`${agents.length} agents.`, 'One real review.'], agentsSub: `${cands.length} rebuild it from the base without seeing the PR.${atk ? ' One attacks it.' : ''} One judges.`, solve: ['Each one rebuilt', 'the change.'], solveSub: cands.map((c) => `${c.id}: ${CAND[c.status] || c.status}`).join(' · ') },
      verdict: { verdict: stv === 'ready-for-human' ? 'coincide' : stv === 'request-changes' ? 'difiere' : 'dudoso', leader: 'JDG', members: camp, groups, prConceded: stv === 'request-changes',
        lines: sc != null ? [`${sc}/10`, `${label}.`] : ['No score.', `${label}.`], big: sc != null,
        summary: `${finds.length} ${finds.length === 1 ? 'attack' : 'attacks'}, ${finds.filter((f) => f.classification === 'refuted').length} refuted · ${pend ? `${pend} open ${pend === 1 ? 'blocker' : 'blockers'}` : 'no open blockers'} · ${PROFILE[b.options?.profile]?.[0] || 'Review'} in ${secs(b.timing?.totalMs || 0)}.` },
    };
  }
  function debateFor(p) {
    if (S.run?.brief?.version >= 2 && S.cur?.id === p.id) return realDebate(S.run.brief);
    const r = rng(p.id); const pick = (a) => a[Math.floor(r() * a.length)];
    const fs = (S.run?.brief?.files || S.plan?.files || []).filter((f) => f.kind === 'source' || f.kind === 'test').map((f) => base(f.path));
    const f1 = fs[0] || 'the main file', f2 = fs[1] || f1;
    const agents = PERSONAS.map(([id, nm, color, t, tp]) => ({ id, name: nm, color, role: 'solver', temperature: t, topP: tp, files: 1 + Math.floor(r() * 4), tests: Math.floor(r() * 3), steps: 3 + Math.floor(r() * 6) }));
    agents.push({ id: 'PR', name: 'The PR', color: '#f5f5f7', role: 'advocate', files: Math.max(1, fs.length), tests: 0, steps: 0 });
    const tone = state(p).tone;
    const kind = tone === 'ok' ? 'coincide' : tone === 'bad' ? 'difiere' : pick(['difiere', 'difiere', 'coincide', 'dudoso']);
    const SAY = {
      convinced: [[`${f1} lets the result go below zero.`, 'Fair point. Clamping it is the safer read.'], [`The loop in ${f1} skips the last item.`, 'You’re right: off by one. I concede.'], ['The requirement says never mutate the input.', 'Mine mutates it. You win this one.']],
      equivalent: [['Same behaviour, different names.', 'Agreed: the tests can’t tell us apart.'], [`We guard ${f1} the same way.`, 'Equivalent. Moving on.'], ['Mine is two lines shorter.', 'Shorter, not different. Same result.']],
      hold: [['Mine also covers the empty case.', 'That case isn’t in the requirement.'], [`I’d split ${f2} into two steps.`, 'One step reads better. I keep mine.'], ['Your version allocates on every call.', 'It’s not a hot path. Mine stays.']],
    };
    const R = (pair, k) => { const say = pick(SAY[k]); return { pair, kind: k, winner: k === 'convinced' ? pair[0] : null, loser: k === 'convinced' ? pair[1] : null, arguments: { [pair[0]]: { argument: say[0] }, [pair[1]]: { argument: say[1] } } }; };
    const plan = {
      coincide: [R(['A', 'PR'], 'equivalent'), R(['B', 'E'], 'convinced'), R(['C', 'D'], 'equivalent'), R(['B', 'A'], 'hold'), R(['C', 'A'], 'equivalent')],
      difiere: [R(['A', 'PR'], 'convinced'), R(['B', 'E'], 'convinced'), R(['C', 'D'], 'equivalent'), R(['A', 'B'], 'hold'), R(['C', 'A'], 'equivalent')],
      dudoso: [R(['A', 'PR'], 'hold'), R(['B', 'E'], 'equivalent'), R(['C', 'D'], 'hold'), R(['A', 'B'], 'hold')],
    }[kind];
    const rounds = plan.map((x, i) => ({ round: i + 1, ...x }));
    const fin = groupsOf(rounds), top = fin[0];
    const conceded = rounds.some((d) => d.loser === 'PR');
    const summary = { coincide: 'The consensus matches what the PR did.', difiere: `The consensus fixes something the PR missed in ${f1}.`, dudoso: 'The agents split. Read this one yourself.' }[kind];
    return {
      sample: true, agents, rounds, agreement: Math.round((0.55 + r() * 0.3) * 100),
      pre: groupsOf(rounds.slice(0, 3).filter((d) => d.kind === 'equivalent')), // fixes that came out the same before anyone argued
      verdict: { verdict: kind, leader: top.find((id) => id !== 'PR') || top[0], members: top, prInConsensus: top.includes('PR') && !conceded, prConceded: conceded, groups: fin, summary },
    };
  }
  const agentName = (id) => D.data.agents.find((a) => a.id === id)?.name || id;
  function chapters(d) {
    if (d.real) return [
      { id: 'agents', dur: 4300, lines: d.text.agents, sub: d.text.agentsSub },
      { id: 'solve', dur: 4300, lines: d.text.solve, sub: d.text.solveSub },
      ...(d.rounds.length ? [{ id: 'debate', dur: d.rounds.length * ROUND, lines: [], sub: '' }] : []),
      { id: 'verdict', dur: 0, lines: d.verdict.lines, sub: d.verdict.summary, big: d.verdict.big },
    ];
    const n = d.agents.length, m = d.verdict.members.length, lead = agentName(d.verdict.leader);
    const V = { coincide: [`${m} of ${n}`, 'agree with the PR.'], difiere: [`${m} of ${n}`, `side with ${lead}.`], dudoso: ['No clear', 'majority.'] }[d.verdict.verdict];
    return [
      { id: 'agents', dur: 4300, lines: [`${n} agents.`, 'One requirement.'], sub: `${n - 1} solve it blind. One argues for the PR.` },
      { id: 'solve', dur: 4300, lines: ['Each one wrote', 'its own fix.'], sub: 'Nobody saw the PR.' },
      { id: 'compare', dur: 4300, lines: ['Then the fixes', 'were compared.'], sub: `${d.agreement}% of the code came out the same.` },
      { id: 'debate', dur: d.rounds.length * ROUND, lines: [], sub: '' },
      { id: 'verdict', dur: 0, lines: V, sub: d.verdict.summary, big: d.verdict.verdict !== 'dudoso' },
    ];
  }
  /* Colours after the first k rounds: whoever was convinced takes the winner's colour. */
  function colorsUpTo(k) {
    const c = Object.fromEntries(D.data.agents.map((a) => [a.id, a.color]));
    D.data.rounds.slice(0, k).forEach((d) => { if (d.kind === 'convinced') c[d.loser] = c[d.winner]; });
    return c;
  }

  /* ── Stage ─────────────────────────────────────────────────────────── */
  function geom() {
    const W = sec.clientWidth || innerWidth, H = sec.clientHeight || innerHeight, narrow = W < 760;
    return { W, H, narrow, cx: narrow ? W / 2 : W * 0.62, cy: narrow ? H * 0.37 : H * 0.47, R0: Math.max(28, Math.min(52, Math.min(W, H) * 0.054)), ring: Math.min(narrow ? W * 0.32 : W * 0.23, H * (narrow ? 0.19 : 0.27)) };
  }
  const bub = (id) => D.B.find((b) => b.id === id);
  function build() {
    blobs.innerHTML = ''; labels.innerHTML = ''; $('dmsgs').innerHTML = ''; D.msgs = [];
    D.B = D.data.agents.map((a, i) => {
      const b = { id: a.id, a, i, x: 0, y: 0, r: 0, tx: 0, ty: 0, tr: 0, col: a.color, shown: '', touch: null, sat: 0, pulse: 0, orbit: 1, sub: '', dim: false, fs: 0 };
      b.sats = [0, 1].map(() => ({ r: 0, el: mk('circle', { r: 0, class: 'sat' }, blobs) }));
      b.el = mk('circle', { r: 0, class: 'blob', role: 'button', 'aria-label': a.name });
      blobs.appendChild(b.el);
      b.el.onclick = (e) => { e.stopPropagation(); openAgent(a.id); };
      b.lab = mk('g', { class: 'blab' }, labels);
      b.nm = mk('text', { 'text-anchor': 'middle', class: 'bn' }, b.lab); b.nm.textContent = a.name;
      b.sb = mk('text', { 'text-anchor': 'middle', class: 'bs' }, b.lab);
      return b;
    });
  }
  function ringOf(list, g, rad, sy = 1, off = 0) {
    list.forEach((b, k) => { const a = -Math.PI / 2 + off + (k * 2 * Math.PI) / list.length; b.tx = g.cx + Math.cos(a) * rad; b.ty = g.cy + Math.sin(a) * rad * sy; });
  }
  /* Members of one group sit close enough to melt into a single shape. */
  function pack(ids, gx, gy, r, key) {
    const m = ids.length, rho = m === 1 ? 0 : r * (m === 2 ? 0.78 : m === 3 ? 0.95 : 1.12);
    ids.forEach((id, j) => { const b = bub(id); const a = (j * 2 * Math.PI) / m - Math.PI / 2; Object.assign(b, { tx: gx + Math.cos(a) * rho, ty: gy + Math.sin(a) * rho, tr: r, touch: m > 1 ? key : null }); });
  }
  function reset(cols) { D.B.forEach((b) => Object.assign(b, { col: cols[b.id], touch: null, sat: 0, pulse: 0, orbit: 1, dim: false, sub: '' })); }
  function setGlow(c) { sec.style.setProperty('--glow', c); }

  function enter(i, keepTime) {
    const elapsed = keepTime ? performance.now() - D.chAt : 0;
    D.ch = Math.max(0, Math.min(D.chs.length - 1, i)); D.chAt = performance.now() - elapsed; D.sub = -1; D.rs = null;
    clearMsgs();
    const ch = D.chs[D.ch], g = geom(), d = D.data;
    progress(elapsed);
    sec.dataset.ch = ch.id;
    $('dprev').disabled = D.ch === 0; $('dnext').disabled = D.ch === D.chs.length - 1;
    if (ch.id !== 'debate') headline(ch.lines, ch.sub, ch.big);
    reset(colorsUpTo(ch.id === 'verdict' ? d.rounds.length : 0));
    if (ch.id === 'agents' || ch.id === 'solve') {
      ringOf(D.B, g, g.ring * (ch.id === 'solve' ? 1.14 : 1));
      D.B.forEach((b) => Object.assign(b, {
        tr: g.R0 * (b.id === 'PR' ? 0.9 : 1), sat: b.a.role === 'solver' || !D.data.real ? 6.5 : 0, pulse: 3, orbit: ch.id === 'solve' ? 2.4 : 1,
        sub: ch.id === 'agents' ? b.a.subA ?? (b.a.role === 'advocate' ? 'for the PR' : `temp ${b.a.temperature}`) : b.a.subB ?? (b.a.role === 'advocate' ? 'the real PR' : `${b.a.files} files · ${b.a.tests} tests`),
      }));
      setGlow(ch.id === 'agents' ? '#e3dcf4' : '#cde4ee');
    } else if (ch.id === 'compare') {
      const n = d.pre.length;
      d.pre.forEach((m, gi) => { const a = -Math.PI / 2 + 0.35 + (gi * 2 * Math.PI) / n; pack(m, g.cx + Math.cos(a) * g.ring * 0.95, g.cy + Math.sin(a) * g.ring * 0.85, g.R0, 'g' + gi); });
      setGlow('#bfe3d0');
    } else if (ch.id === 'verdict') {
      const [top, ...rest] = d.verdict.groups;
      pack(top, g.cx, g.cy, g.R0 * 1.15, 'win');
      rest.forEach((m, k) => { const a = -Math.PI / 2 + ((k + 1) * 2 * Math.PI) / (rest.length + 1); pack(m, g.cx + Math.cos(a) * g.ring * 1.35, g.cy + Math.sin(a) * g.ring * 1.2, g.R0 * 0.7, 'v' + k); });
      setGlow(bub(d.verdict.leader).col);
    }
  }
  /* The debate chapter plays its rounds one after another: meet, argue, outcome. */
  function debateTick(t) {
    // A frame's timestamp can be a few ms older than the chapter start: never a round −1.
    const d = D.data; if (!d.rounds.length) return;
    const k = Math.max(0, Math.min(d.rounds.length - 1, Math.floor(t / ROUND))), u = Math.max(0, t - k * ROUND);
    if (k !== D.sub) startRound(k);
    const rd = d.rounds[k], rs = D.rs;
    if (!rs.s1 && u > 600) { rs.s1 = true; say(rd.pair[0], rd.arguments[rd.pair[0]].argument, 'l'); }
    if (!rs.s2 && u > 1200) { rs.s2 = true; say(rd.pair[1], rd.arguments[rd.pair[1]].argument, 'r'); }
    if (!rs.out && u > 2500) { rs.out = true; clearMsgs(); outcome(rd, k); } // the arguments step aside as the outcome lands
  }
  function startRound(k) {
    D.sub = k; D.rs = {}; clearMsgs();
    const g = geom(), rd = D.data.rounds[k], cols = colorsUpTo(k);
    reset(cols);
    headline(rd.attack ? ['The attacker', `tests the PR.`] : rd.kind === 'talk' ? [`${agentName(rd.pair[0])} and`, `${agentName(rd.pair[1])}.`] : [agentName(rd.pair[0]), `vs ${agentName(rd.pair[1])}.`], rd.attack ? `Attack ${rd.attack}` : `Round ${k + 1} of ${D.data.rounds.length}`);
    const others = D.B.filter((b) => !rd.pair.includes(b.id));
    ringOf(others, g, g.ring * 1.32, 0.95, Math.PI / others.length);
    others.forEach((b) => Object.assign(b, { tr: g.R0 * 0.55, dim: true }));
    rd.pair.forEach((id, j) => Object.assign(bub(id), { tx: g.cx + (j ? 1 : -1) * g.R0 * 1.75, ty: g.cy, tr: g.R0 * 1.15, pulse: 2 }));
    setGlow(cols[rd.pair[0]]);
  }
  function outcome(rd, k) {
    const g = geom(), [a, b] = rd.pair.map(bub);
    let sub = `Round ${k + 1} of ${D.data.rounds.length}`;
    a.pulse = b.pulse = 0;
    if (rd.attack) sub = `Attack ${rd.attack}`;
    if (rd.kind === 'talk') {
      a.tx = g.cx - g.R0 * 0.62; b.tx = g.cx + g.R0 * 0.62; a.touch = b.touch = 'm';
      headline(rd.attack ? ['Not settled', 'in time.'] : rd.phase === 'results' ? ['They revised', 'after the tests.'] : ['They traded', 'risks.'], sub);
    } else if (rd.kind === 'convinced') {
      const w = bub(rd.winner), l = bub(rd.loser);
      Object.assign(w, { tr: g.R0 * 1.3, touch: 'm' });
      Object.assign(l, { tx: w.tx + Math.sign(l.tx - w.tx) * g.R0 * 0.75, tr: g.R0 * 0.9, touch: 'm', col: w.col });
      headline(rd.attack ? ['The attack', 'landed.'] : [`${w.a.name} convinced`, `${l.a.name}.`], sub);
      setGlow(w.col);
    } else if (rd.kind === 'equivalent') {
      a.tx = g.cx - g.R0 * 0.62; b.tx = g.cx + g.R0 * 0.62; a.touch = b.touch = 'm';
      headline([`${a.a.name} and ${b.a.name}:`, 'the same fix.'], sub);
    } else {
      a.tx = g.cx - g.R0 * 2.9; b.tx = g.cx + g.R0 * 2.9; a.vx = -9; b.vx = 9;
      headline(rd.attack ? ['The PR', 'held.'] : ['Nobody', 'gave in.'], sub);
    }
  }

  /* ── Wrapped-style type: lines slide up from under a mask ──────────── */
  function headline(lines, sub, big) {
    const el = $('dline'), key = lines.join('|') + '#' + sub;
    if (el.dataset.key === key) return;
    el.dataset.key = key;
    el.querySelectorAll('.hlb').forEach((o) => { if (o.classList.contains('out')) return; o.classList.remove('in'); o.classList.add('out'); setTimeout(() => o.remove(), 600); });
    const box = document.createElement('div'); box.className = 'hlb' + (big ? ' big' : '');
    box.innerHTML = lines.map((l, i) => `<span class="ln"><span style="--i:${i}">${esc(l)}</span></span>`).join('') + (sub ? `<p style="--i:${lines.length}">${esc(sub)}</p>` : '');
    el.appendChild(box);
    requestAnimationFrame(() => requestAnimationFrame(() => box.classList.add('in')));
  }
  /* Story bars on top: the current one fills over the chapter's length. */
  function progress(elapsed = 0) {
    const el = $('dprog');
    if (el.children.length !== D.chs.length) el.innerHTML = D.chs.map(() => '<i><b></b></i>').join('');
    [...el.children].forEach((s, i) => { const b = s.firstChild; b.style.transition = 'none'; b.style.width = i < D.ch ? '100%' : '0%'; });
    const cur = el.children[D.ch]?.firstChild, dur = D.chs[D.ch].dur;
    if (!cur) return;
    if (!dur) { cur.style.width = '100%'; return; }
    cur.style.width = Math.min(100, (elapsed / dur) * 100) + '%';
    void cur.offsetWidth;
    cur.style.transition = `width ${Math.max(0, dur - elapsed)}ms linear`; cur.style.width = '100%';
  }
  function freezeBar() { const b = $('dprog').children[D.ch]?.firstChild; if (b) { b.style.width = getComputedStyle(b).width; b.style.transition = 'none'; } }

  function say(id, text, side) {
    const b = bub(id); const el = document.createElement('div');
    el.className = 'dmsg ' + side;
    el.innerHTML = `<div><i style="background:${b.a.color}"></i><span><b>${esc(b.a.name)}</b>${esc(text)}</span></div>`;
    $('dmsgs').appendChild(el); D.msgs.push({ el, b });
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('on')));
  }
  function clearMsgs() { D.msgs.forEach((m) => { m.el.classList.remove('on'); m.el.classList.add('gone'); setTimeout(() => m.el.remove(), 400); }); D.msgs = []; }

  /* ── Physics: every bubble springs to its target; groups melt together ─ */
  function frame(now) {
    D.raf = requestAnimationFrame(frame);
    const dt = D.t ? Math.min(3, (now - D.t) / 16.667) : 1; D.t = now;
    const ts = now / 1000, ch = D.chs[D.ch];
    if (D.open && ch && !D.agent) {
      if (ch.id === 'debate') debateTick(now - D.chAt);
      if (ch.dur && now - D.chAt > ch.dur && D.ch < D.chs.length - 1) enter(D.ch + 1);
    }
    // Bubbles that are not meant to touch keep a little air between them (touching melts them together).
    for (let i = 0; i < D.B.length; i++) for (let j = i + 1; j < D.B.length; j++) {
      const a = D.B[i], b = D.B[j];
      if ((a.touch && a.touch === b.touch) || a.tr < 2 || b.tr < 2 || D.agent) continue;
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1, min = a.r + b.r + 22;
      if (d < min) { const f = ((min - d) / d) * 0.08 * dt; a.x -= dx * f; a.y -= dy * f; b.x += dx * f; b.y += dy * f; }
    }
    D.B.forEach((b, i) => {
      const w = D.agent ? 0 : 7, wx = Math.sin(ts * 0.55 + i * 1.7) * w, wy = Math.cos(ts * 0.5 + i * 1.1) * w;
      const tr = Math.max(0, b.tr + (b.pulse ? Math.sin(ts * 2.2 + i) * b.pulse : 0));
      if (RM) Object.assign(b, { x: b.tx, y: b.ty, r: b.tr });
      else { const K = D.agent === b.id ? 0.045 : 0.028; spring(b, 'x', b.tx + wx, K, dt, 0.78); spring(b, 'y', b.ty + wy, K, dt, 0.78); spring(b, 'r', tr, K * 1.1, dt, 0.72); }
      const r = Math.max(0, b.r);
      b.el.setAttribute('cx', b.x.toFixed(1)); b.el.setAttribute('cy', b.y.toFixed(1)); b.el.setAttribute('r', r.toFixed(1));
      if (b.shown !== b.col) { b.shown = b.col; b.el.style.fill = b.col; b.sats.forEach((s) => (s.el.style.fill = b.col)); }
      b.sats.forEach((s, j) => {
        spring(s, 'r', b.sat, 0.05, dt);
        const a = ts * 0.9 * b.orbit + j * Math.PI + i * 0.9, rr = r + 15;
        s.el.setAttribute('cx', (b.x + Math.cos(a) * rr).toFixed(1)); s.el.setAttribute('cy', (b.y + Math.sin(a) * rr).toFixed(1)); s.el.setAttribute('r', Math.max(0, s.r).toFixed(1));
      });
      const fs = Math.round(Math.max(11, Math.min(17, r * 0.31)));
      if (fs !== b.fs) { b.fs = fs; b.nm.style.fontSize = fs + 'px'; }
      if (b.sb.textContent !== b.sub) b.sb.textContent = b.sub;
      b.nm.setAttribute('y', b.sub ? -2 : fs * 0.36); b.sb.setAttribute('y', fs * 0.9 + 2);
      b.lab.setAttribute('transform', `translate(${b.x.toFixed(1)},${b.y.toFixed(1)})`);
      b.lab.classList.toggle('tiny', r < 30); b.lab.classList.toggle('dim', b.dim);
    });
    const SW = sec.clientWidth;
    D.msgs.forEach((m) => { // follows its bubble, kept inside the screen
      const w = m.w || (m.w = m.el.offsetWidth), r = m.el.classList.contains('r');
      const x = r ? Math.min(m.b.x, SW - 12 - w + 30) : Math.max(m.b.x, 12 + w - 30);
      m.el.style.left = x + 'px'; m.el.style.top = m.b.y - Math.max(0, m.b.r) - 12 + 'px';
    });
  }
  const run = () => { if (!D.raf) { D.t = 0; D.raf = requestAnimationFrame(frame); } };

  /* ── Diving into one agent: its bubble grows until it is the whole screen ─ */
  function openAgent(id) {
    const b = bub(id); if (!b || !D.open) return false;
    if (D.agent === id) return true;
    if (!D.agent) { D.paused = performance.now(); freezeBar(); }
    D.agent = id; clearMsgs();
    const g = geom();
    D.B.forEach((o) => (o === b ? Object.assign(o, { tx: g.W / 2, ty: g.H / 2, tr: Math.hypot(g.W, g.H) * 0.62, touch: 'agent', sat: 0, pulse: 0 }) : Object.assign(o, { tr: 0, sat: 0 })));
    sec.classList.add('inagent'); setGlow(b.col);
    const el = $('agent'); el.classList.remove('on'); el.hidden = true;
    setTimeout(() => { if (D.agent !== id) return; fillAgent(b.a); el.hidden = false; requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('on'))); }, 420);
    return true;
  }
  function closeAgent() {
    if (!D.agent) return false;
    D.agent = null; D.chAt += performance.now() - D.paused;
    const el = $('agent'); el.classList.remove('on'); setTimeout(() => { if (!D.agent) el.hidden = true; }, 380);
    sec.classList.remove('inagent');
    enter(D.ch, true);
    return true;
  }
  function fillAgent(a) {
    const d = D.data, mine = d.rounds.filter((r) => r.pair.includes(a.id));
    const story = mine.map((r) => {
      const other = agentName(r.pair.find((x) => x !== a.id));
      const t = r.attack ? (r.kind === 'convinced' ? (a.id === 'ATK' ? `Broke the PR (${r.attack})` : `Broken by attack ${r.attack}`) : r.kind === 'hold' ? (a.id === 'ATK' ? `Attack ${r.attack} refuted` : `Held against attack ${r.attack}`) : `Attack ${r.attack}: not settled`)
        : r.kind === 'talk' ? (r.phase === 'results' ? `Revised after the tests, with ${other}` : `Traded risks with ${other}`)
        : r.kind === 'convinced' ? (r.winner === a.id ? `Convinced ${other}` : `Was convinced by ${other}`) : r.kind === 'equivalent' ? `Same fix as ${other}` : `Held firm against ${other}`;
      return `<li><span>Round ${r.round}</span>${esc(t)}</li>`;
    }).join('');
    const best = mine.find((r) => r.winner === a.id) || mine.find((r) => r.kind !== 'convinced') || mine[0];
    const quote = a.quote ?? best?.arguments[a.id]?.argument;
    const stats = a.stats ? a.stats : a.role === 'advocate'
      ? [[a.files, a.files === 1 ? 'file changed' : 'files changed'], [mine.length, mine.length === 1 ? 'debate' : 'debates'], [d.verdict.prConceded ? 'Yes' : 'No', 'conceded']]
      : [[a.files, a.files === 1 ? 'file' : 'files'], [a.tests, a.tests === 1 ? 'test run' : 'tests run'], [a.steps, 'steps']];
    const win = d.verdict.members.includes(a.id);
    $('agent').innerHTML = `<button class="ax" id="ax" aria-label="Back to all agents">×</button>
      <div class="ak">${d.real ? `Live run · ${esc(d.runId || '')}` : a.role === 'advocate' ? 'Advocate · argues for the PR as written' : `Agent ${esc(a.id)} · solved it blind`}</div>
      <div class="an">${esc(a.name)}</div>
      ${a.meta ? `<div class="am">${esc(a.meta)}</div>` : a.role === 'solver' ? `<div class="am">temperature ${a.temperature} · top-p ${a.topP}</div>` : '<div class="am">It never writes code. It defends the PR’s.</div>'}
      <div class="as">${stats.map(([v, l]) => `<div><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join('')}</div>
      ${quote ? `<blockquote>“${esc(quote)}”</blockquote>` : ''}
      <ul class="ar">${story}</ul>
      <div class="af">${d.real ? esc(d.verdict.lines.join(' ')) : d.verdict.verdict === 'dudoso' ? 'No camp won.' : win ? `In the winning camp${d.verdict.leader === a.id ? ', as its leader' : ''}.` : 'Outside the winning camp.'}</div>`;
    $('ax').onclick = (e) => { e.stopPropagation(); closeAgent(); };
  }

  /* ── Entering and leaving: the camera falls into the core, the agents come out of it ─ */
  function openDebate() {
    const full = $('full');
    if (full.hidden || !full.classList.contains('open') || !S.cur) return false;
    if (D.open) return true;
    clearTimeout(D.hideT);
    D.data = debateFor(S.cur); D.chs = chapters(D.data); D.open = true; D.agent = null; D.ch = -1;
    $('dtitle').textContent = `Agents · ${name(S.cur)}`;
    sec.querySelector('.dbar em').textContent = D.data.real ? `Live run · ${D.data.runId}` : 'Preview · sample data';
    $('drawer').hidden = true;
    focusOn(['pr'], { k: 5.5, K: 0.03, noTip: true, still: true });
    full.classList.add('indebate');
    build();
    const [fx, fy] = focusPoint();
    D.B.forEach((b, i) => Object.assign(b, { x: fx + Math.cos(i) * 3, y: fy + Math.sin(i) * 3, r: 0, tx: fx, ty: fy, tr: 0, vx: 0, vy: 0, vr: 0 }));
    $('dline').innerHTML = ''; delete $('dline').dataset.key; $('dprog').innerHTML = '';
    sec.classList.remove('inagent'); $('agent').hidden = true;
    sec.hidden = false; void sec.offsetWidth; sec.classList.add('on');
    run();
    setTimeout(() => { if (D.open && D.ch < 0) enter(0); }, 380);
    return true;
  }
  function closeDebate(instant) {
    if (!D.open) return false;
    D.open = false; D.agent = null; clearMsgs();
    const el = $('agent'); el.classList.remove('on'); el.hidden = true;
    sec.classList.remove('on', 'inagent'); $('full').classList.remove('indebate');
    const [fx, fy] = focusPoint();
    D.B.forEach((b) => Object.assign(b, { tx: fx, ty: fy, tr: 0, sat: 0, pulse: 0 }));
    if (!instant) zoomGraph('fit');
    clearTimeout(D.hideT);
    D.hideT = setTimeout(() => { if (!D.open) { sec.hidden = true; cancelAnimationFrame(D.raf); D.raf = 0; } }, instant ? 0 : 650);
    return true;
  }
  function go(delta) { if (!D.open) return; if (D.agent) closeAgent(); enter(D.ch + delta); }
  const CH = { agents: 0, meet: 0, solve: 1, blind: 1, compare: 2, debate: 3, rounds: 3, argue: 3, verdict: 4, consensus: 4, result: 4 };
  function debateGo(to) {
    if (!D.open) return false;
    if (to === 'next') go(1); else if (to === 'previous' || to === 'back') go(-1);
    else {
      if (D.agent) closeAgent();
      const want = { meet: 'agents', blind: 'solve', rounds: 'debate', argue: 'debate', attacks: 'debate', consensus: 'verdict', result: 'verdict' }[to] || to;
      const i = D.chs.findIndex((c) => c.id === want);
      enter(to === 'restart' ? 0 : i >= 0 ? i : D.ch);
    }
    return D.chs[D.ch]?.id;
  }
  function debateInfo() {
    if (!D.data) return null;
    const d = D.data;
    return {
      sample: !d.real, note: d.real ? `Real review run ${d.runId}: alternatives rebuilt from the base, their debate, attacks on the PR and the judge.` : 'Design preview with sample data: this PR has no real review run yet.',
      chapter: D.chs[D.ch]?.id, openAgent: D.agent ? agentName(D.agent) : null,
      agents: d.agents.map((a) => ({ id: a.id, name: a.name, role: a.role, temperature: a.temperature })),
      rounds: d.rounds.map((r) => ({ round: r.round, pair: r.pair.map(agentName), attack: r.attack, outcome: r.attack ? { convinced: 'the attack landed: the PR fails', hold: 'refuted: the PR passes', talk: 'not settled' }[r.kind] : r.kind === 'talk' ? (r.phase === 'results' ? 'revised after the tests' : 'traded risks') : r.kind === 'convinced' ? `${agentName(r.winner)} convinced ${agentName(r.loser)}` : r.kind === 'equivalent' ? 'same fix' : 'nobody gave in', arguments: Object.fromEntries(Object.entries(r.arguments).map(([k, v]) => [agentName(k), v.argument])) })),
      verdict: d.real ? { headline: d.verdict.lines.join(' '), summary: d.verdict.summary } : { kind: d.verdict.verdict, leader: agentName(d.verdict.leader), camp: d.verdict.members.map(agentName), prConceded: d.verdict.prConceded, summary: d.verdict.summary },
    };
  }
  function findAgent(q) {
    const s = String(q || '').toLowerCase().trim(); if (!D.data) return null;
    return D.data.agents.find((a) => a.id.toLowerCase() === s || a.name.toLowerCase() === s)
      || D.data.agents.find((a) => s.includes(a.name.toLowerCase()) || a.name.toLowerCase().includes(s))
      || (/\bpr\b|advocate|abogado|defens|original/.test(s) ? D.data.agents.find((a) => a.id === 'PR') : null)
      || (/judge|juez/.test(s) ? D.data.agents.find((a) => a.id === 'JDG') : null) || (/attack|atac/.test(s) ? D.data.agents.find((a) => a.id === 'ATK') : null);
  }

  /* ── Input ─────────────────────────────────────────────────────────── */
  $('agentsBtn').onclick = openDebate;
  $('dclose').onclick = (e) => { e.stopPropagation(); closeDebate(); };
  $('dprev').onclick = (e) => { e.stopPropagation(); go(-1); };
  $('dnext').onclick = (e) => { e.stopPropagation(); go(1); };
  sec.addEventListener('click', (e) => { // like a story: tap the right side for next, the left edge for back
    if (D.agent || e.target.closest('button, .dagent, .blob')) return;
    go(e.clientX < sec.clientWidth * 0.25 ? -1 : 1);
  });
  addEventListener('keydown', (e) => {
    if (!D.open || e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
  });
  let rz = 0;
  addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (D.open && !D.agent && D.ch >= 0) enter(D.ch, true); }, 200); });

  Object.assign(window, {
    openDebate, closeDebate, debateGo, debateInfo,
    openAgent: (q) => { const a = findAgent(q); return a && openAgent(a.id) ? a : null; },
    closeAgent, debateOpen: () => D.open, agentOpen: () => (D.agent ? agentName(D.agent) : null),
    debateEscape: () => (D.agent ? closeAgent() : D.open ? closeDebate() : false),
  });
})();
