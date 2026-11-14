/* Katse voice mascot. Bottom-right goat; Space or a click starts a real-time voice session with Gemini Live
   (gemini-3.8-live) through a single-use ephemeral token from /api/live/token. The model drives the app through
   tools that call app.js globals (S, openGraph, closeGraph, openReview, highlightLanes, verify, reloadPRs).
   Audio: mic → 16 kHz PCM16 chunks of ~32 ms; model audio 24 kHz PCM16 → scheduled AudioBuffers; the goat's mouth
   follows the playback amplitude; barge-in flushes playback on `interrupted`. */
import { injectGoatCSS, createGoat, setGoatState } from './goat.js';

const app = () => (typeof S !== 'undefined' ? S : null); // S is a top-level const of app.js (global lexical scope)
const call = (name, ...a) => (typeof window[name] === 'function' ? window[name](...a) : undefined);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LANG = (navigator.language || 'en').toLowerCase().startsWith('es') ? 'es' : 'en';
let sess = null; // the live Gemini session, if any

/* ── DOM ─────────────────────────────────────────────────────────────── */
injectGoatCSS();
const root = document.createElement('div');
root.className = 'mascot';
root.innerHTML = `
  <div class="m-panel" role="dialog" aria-label="Katse assistant" aria-live="polite">
    <div class="m-head"><span class="m-live"><i></i><b>Katse</b><em class="m-status">Ready</em></span><button class="m-x" type="button" aria-label="End conversation">×</button></div>
    <div class="m-lines"></div>
    <div class="m-acts"></div>
    <form class="m-type"><input type="text" placeholder="Type instead…" aria-label="Type a message" autocomplete="off"><button type="submit" aria-label="Send">↵</button></form>
  </div>
  <div class="m-hint">Talk to me <kbd>Space</kbd></div>
  <button class="m-goat" type="button" aria-label="Talk to the Katse assistant (Space)"><span class="m-ring"></span><span class="m-ring m-ring2"></span>${createGoat('idle', 'dock')}</button>`;
document.body.appendChild(root);
const goatBtn = root.querySelector('.m-goat');
const svg = goatBtn.querySelector('svg');
const panel = root.querySelector('.m-panel');
const linesEl = root.querySelector('.m-lines');
const actsEl = root.querySelector('.m-acts');
const statusEl = root.querySelector('.m-status');
const typeForm = root.querySelector('.m-type');
const typeInput = typeForm.querySelector('input');

/* ── Goat state + look-at ─────────────────────────────────────────────── */
let mood = null; let moodTimer = 0; let base = 'idle'; let lastActive = performance.now();
function face(state) { base = state; if (!mood) setGoatState(svg, state); root.dataset.state = state; }
function express(m, ms = 2600) {
  mood = m; setGoatState(svg, m); clearTimeout(moodTimer);
  moodTimer = setTimeout(() => { mood = null; setGoatState(svg, base); }, ms);
}
let tx = 0, ty = 0, cx = 0, cy = 0;
addEventListener('pointermove', (e) => {
  const r = svg.getBoundingClientRect();
  tx = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / 420));
  ty = Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height / 2)) / 360));
  lastActive = performance.now();
  if (base === 'sleeping') face('idle');
}, { passive: true });
svg.classList.add('tracking');

/* ── Panel text ───────────────────────────────────────────────────────── */
let userLine = null, goatLine = null;
function status(t) { statusEl.textContent = t; }
function line(who, text = '') {
  const el = document.createElement('p'); el.className = `m-l ${who}`; el.textContent = text;
  linesEl.appendChild(el);
  while (linesEl.children.length > 6) linesEl.firstChild.remove();
  linesEl.scrollTop = linesEl.scrollHeight;
  return el;
}
function addText(el, t) { el.textContent += t; linesEl.scrollTop = linesEl.scrollHeight; }
function act(text, tone = '') {
  const el = document.createElement('span'); el.className = `m-act ${tone}`; el.textContent = text;
  actsEl.appendChild(el);
  while (actsEl.children.length > 3) actsEl.firstChild.remove();
  setTimeout(() => el.classList.add('old'), 9000);
}

/* ── Audio: playback (24 kHz) with amplitude for lip-sync ─────────────── */
let outCtx = null, outGain = null, analyser = null, nextAt = 0; const sources = new Set();
function ensureOut() {
  if (outCtx) return;
  outCtx = new AudioContext({ sampleRate: 24000 });
  outGain = outCtx.createGain(); analyser = outCtx.createAnalyser(); analyser.fftSize = 512;
  outGain.connect(analyser); analyser.connect(outCtx.destination);
}
function b64ToF32(b64) {
  const bin = atob(b64); const n = bin.length >> 1; const out = new Float32Array(n);
  for (let i = 0; i < n; i++) { let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8); if (v >= 32768) v -= 65536; out[i] = v / 32768; }
  return out;
}
function play(b64, rate = 24000) {
  ensureOut();
  const pcm = b64ToF32(b64); if (!pcm.length) return;
  const buf = outCtx.createBuffer(1, pcm.length, rate); buf.copyToChannel(pcm, 0);
  const src = outCtx.createBufferSource(); src.buffer = buf; src.connect(outGain);
  const at = Math.max(outCtx.currentTime + 0.03, nextAt);
  src.start(at); nextAt = at + buf.duration; sources.add(src);
  src.onended = () => sources.delete(src);
}
function flushPlayback() { for (const s of sources) { try { s.stop(); } catch { /* already stopped */ } } sources.clear(); nextAt = 0; }
const speaking = () => outCtx && outCtx.currentTime < nextAt - 0.02;

/* ── Audio: microphone → 16 kHz PCM16 ─────────────────────────────────── */
const WORKLET = `class C extends AudioWorkletProcessor{process(i){const c=i[0]&&i[0][0];if(c)this.port.postMessage(c.slice(0));return true}}registerProcessor('katse-mic',C);`;
let mic = null; let micLevel = 0;
async function startMic(onChunk) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' })));
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'katse-mic');
  const ratio = ctx.sampleRate / 16000; let acc = []; let pos = 0;
  node.port.onmessage = (e) => {
    const f = e.data; let sum = 0;
    for (let i = 0; i < f.length; i++) sum += f[i] * f[i];
    micLevel = micLevel * 0.7 + Math.min(1, Math.sqrt(sum / f.length) * 6) * 0.3;
    // Linear resample to 16 kHz.
    for (; pos < f.length; pos += ratio) { const i = Math.floor(pos), t = pos - i; acc.push(f[i] * (1 - t) + (f[i + 1] ?? f[i]) * t); }
    pos -= f.length;
    if (acc.length >= 512) { onChunk(acc); acc = []; }
  };
  src.connect(node); // the worklet produces no output; nothing reaches the speakers
  mic = { stream, ctx, node };
}
function stopMic() { if (!mic) return; mic.stream.getTracks().forEach((t) => t.stop()); mic.ctx.close().catch(() => {}); mic = null; micLevel = 0; }
function f32ToB64(arr) {
  const buf = new ArrayBuffer(arr.length * 2); const v = new DataView(buf);
  for (let i = 0; i < arr.length; i++) { const s = Math.max(-1, Math.min(1, arr[i])); v.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
  const u8 = new Uint8Array(buf); let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(bin);
}

/* ── Animation loop: look-at, lip-sync, rings, sleep ──────────────────── */
let amp = 0;
(function loop() {
  cx += (tx - cx) * 0.12; cy += (ty - cy) * 0.12;
  svg.style.setProperty('--lx', cx.toFixed(3)); svg.style.setProperty('--ly', cy.toFixed(3));
  let a = 0;
  if (analyser && speaking()) {
    const d = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(d);
    let s = 0; for (let i = 0; i < d.length; i++) s += d[i] * d[i];
    a = Math.min(1, Math.sqrt(s / d.length) * 5.5);
  }
  amp += (a - amp) * (a > amp ? 0.55 : 0.25);
  svg.style.setProperty('--amp', amp.toFixed(3));
  if (sess) {
    const want = speaking() ? 'talking' : sess.busy ? 'thinking' : 'listening';
    if (base !== want) face(want);
    root.style.setProperty('--lvl', (want === 'talking' ? amp : micLevel).toFixed(3));
  } else {
    root.style.setProperty('--lvl', '0');
    if (base !== 'sleeping' && performance.now() - lastActive > 120000) face('sleeping');
  }
  requestAnimationFrame(loop);
})();

/* ── Tools: what the goat can see and do in the app ───────────────────── */
const T = (props = {}, required = []) => ({ type: 'OBJECT', properties: props, ...(required.length ? { required } : {}) });
const TOOLS = [
  { name: 'get_screen', description: 'What the user is looking at right now: home (branch tree), the graph of one pull request, or its review drawer; plus that PR and its verification summary. Call it whenever the user says "this", "here" or you are unsure.', parameters: T() },
  { name: 'list_pull_requests', description: 'List the pull requests (branches) of the current project with their verification state, and point at them on screen. By default only the active ones (recent or already verified); older stale branches only if include_old is true.', parameters: T({ direction: { type: 'STRING', enum: ['incoming', 'outgoing', 'all'], description: 'incoming = others want to merge into the base; outgoing = the user\'s own branches. Default all.' }, include_old: { type: 'BOOLEAN', description: 'Also include old, stale branches. Default false.' } }) },
  { name: 'highlight_pull_requests', description: 'Point at specific pull requests in the branch tree (dims the rest). Empty list clears.', parameters: T({ ids: { type: 'ARRAY', items: { type: 'STRING' }, description: 'PR ids from list_pull_requests' } }, ['ids']) },
  { name: 'open_pull_request', description: 'Open one pull request full screen. Accepts its id, branch, number, a word from its title, or an ordinal like "first"/"second".', parameters: T({ query: { type: 'STRING' } }, ['query']) },
  { name: 'go_home', description: 'Close the pull request and go back to the branch tree.', parameters: T() },
  { name: 'get_verification_details', description: 'Details of the current pull request verification, for explaining it: verdict lane, recommendation, what was checked and how (tests red-before/green-after, seeded defects, rewind, blind replicas), what was NOT checked and why, the lines the human must read, and the open questions.', parameters: T({ section: { type: 'STRING', enum: ['summary', 'checked', 'not_checked', 'residue', 'questions', 'all'] } }) },
  { name: 'open_review', description: 'Open the review & sign drawer of the current (verified) pull request.', parameters: T() },
  { name: 'start_verification', description: 'Start verifying the current pull request. Slow (minutes). Ask the user to confirm first.', parameters: T({ mode: { type: 'STRING', enum: ['quick', 'full'] } }) },
  { name: 'get_consensus', description: 'Results of the multi-agent consensus for the current pull request: several Gemini agents solved the same requirement blind, a heatmap compared their code zone by zone with the PR, then they debated in pairs until a consensus. Returns agents, where they agreed/disagreed, each debate argument and who convinced whom, and the verdict (coincide = PR matches the consensus, difiere = the consensus proposes something else, dudoso = no clear majority).', parameters: T() },
  { name: 'start_consensus', description: 'Start a multi-agent consensus check on the current pull request (takes ~15 minutes). Ask the user to confirm first.', parameters: T() },
  { name: 'open_consensus', description: 'Show the live consensus view (agent bubbles, debate and heatmap) for the current pull request.', parameters: T() },
  { name: 'express', description: 'Show an emotion with the goat for a moment, to make the conversation lively (e.g. happy when a PR is fine, surprised at a bug).', parameters: T({ mood: { type: 'STRING', enum: ['happy', 'surprised', 'sad', 'confused', 'love', 'bleating', 'thinking'] } }, ['mood']) },
];
for (const t of TOOLS) t.behavior = 'BLOCKING';

function allPRs() {
  const s = app(); if (!s) return [];
  return [...(s.prs?.incoming || []).map((p) => ({ ...p, yours: false })), ...(s.prs?.outgoing || []).map((p) => ({ ...p, yours: true }))];
}
function prState(p) { try { return typeof state === 'function' ? state(p).label : (p.last?.laneName || 'Not verified'); } catch { return p.last?.laneName || 'Not verified'; } }
const prBrief = (p, i) => ({ ordinal: i + 1, id: p.id, branch: p.branch, title: p.title, yours: !!p.yours, state: prState(p), verifying: !!p.running, linesForHuman: p.last ? `${p.last.residue} of ${p.last.total}` : null, commitsAhead: p.ahead, date: p.date });
function view() {
  const full = document.getElementById('full'); const drawer = document.getElementById('drawer');
  if (drawer && !drawer.hidden) return 'review';
  if (full && !full.hidden) return 'graph';
  return 'home';
}
function findPR(q) {
  const list = allPRs(); const s = String(q || '').toLowerCase().trim();
  const ord = { first: 0, primero: 0, primera: 0, second: 1, segundo: 1, segunda: 1, third: 2, tercero: 2, tercera: 2, last: list.length - 1, último: list.length - 1, ultimo: list.length - 1 };
  for (const [k, i] of Object.entries(ord)) if (s.includes(k)) return list[i];
  if (/^\d+$/.test(s) && Number(s) <= list.length && Number(s) < 100) return list[Number(s) - 1];
  return list.find((p) => p.id.toLowerCase() === s) || list.find((p) => p.branch.toLowerCase() === s)
    || list.find((p) => p.branch.toLowerCase().includes(s) || (p.requirement && String(p.requirement) === s.replace('#', '')))
    || list.find((p) => (p.title || '').toLowerCase().includes(s))
    || list.find((p) => s.split(/\s+/).filter((w) => w.length > 2).some((w) => p.branch.toLowerCase().includes(w) || (p.title || '').toLowerCase().includes(w)));
}
function originOf(p) {
  const lane = document.querySelector(`[data-pr="${CSS.escape(p.id)}"]`);
  const r = (lane || goatBtn).getBoundingClientRect();
  return lane ? [r.right - 8, r.top + r.height / 2] : [r.left + r.width / 2, r.top + r.height / 2];
}
async function waitFor(cond, ms = 6000) { const t = performance.now(); while (!cond() && performance.now() - t < ms) await sleep(80); return cond(); }
const clip = (s, n = 400) => (s && String(s).length > n ? String(s).slice(0, n) + '…' : s);
function briefOf(b, section = 'summary') {
  if (!b) return null;
  const out = { lane: b.lane?.name || b.lane?.id, laneId: b.lane?.id, laneMeaning: b.lane?.summary, recommendation: b.recommendation?.name, linesForHuman: b.residue?.lines, totalLines: b.totals?.lines, minutes: b.timing?.totalMs ? Math.round(b.timing.totalMs / 6000) / 10 : null };
  const want = (k) => section === 'all' || section === k || (section === 'summary' && k !== 'residue');
  if (want('checked')) out.checked = (b.claims || []).slice(0, 14).map((c) => ({ status: c.status, what: clip(c.text, 300) }));
  if (want('not_checked')) out.notChecked = (b.notChecked || []).slice(0, 10).map((n) => ({ what: n.what, why: clip(n.why, 240) }));
  if (want('questions')) out.questions = (b.questions || []).map((q) => ({ question: clip(q.text, 300), options: q.options }));
  if (want('residue') || section === 'summary') out.toRead = (b.residue?.items || []).slice(0, section === 'summary' ? 4 : 10).map((i) => ({ where: `${i.file}:${i.start}${i.end !== i.start ? '-' + i.end : ''}`, lines: i.lines, why: clip(i.reason || i.why || '', 200), code: section === 'summary' ? undefined : clip((i.code || []).map((c) => [...c.removed.map((l) => '- ' + l), ...c.added.map((l) => '+ ' + l)].join('\n')).join('\n'), 700) }));
  const known = new Set(['lane', 'recommendation', 'residue', 'totals', 'timing', 'claims', 'notChecked', 'questions', 'pr', 'cost']);
  out.otherSections = Object.keys(b).filter((k) => !known.has(k)).slice(0, 20);
  return out;
}
async function consensusFor(p) {
  const r = await fetch('/api/consenso'); if (!r.ok) return { available: false, note: 'The consensus engine is not installed on this server yet.' };
  const runs = (await r.json()).filter((x) => x.branch === p.branch);
  if (!runs.length) return { available: true, found: false };
  const c = await (await fetch(`/api/consenso/${encodeURIComponent(runs[0].id)}`)).json();
  const sol = c.solutions || {};
  return {
    available: true, found: true, id: c.id, status: c.status, model: c.model,
    agents: (c.agents || []).map((a) => ({ id: a.id, name: a.name, role: a.role, temperature: a.temperature, topP: a.topP, topK: a.topK, files: sol[a.id]?.files, summary: clip(sol[a.id]?.summary, 260), finished: sol[a.id]?.ok !== false, error: sol[a.id]?.error })),
    heatmap: (c.heatmap?.zones || []).slice(0, 12).map((z) => ({ where: `${z.file}${z.newFile ? ' (new)' : `:${z.start}-${z.end}`}`, agreement: Math.round(z.agreement * 100) + '%', differFromPR: Object.entries(z.cells || {}).filter(([id, v]) => id !== 'PR' && v.same_as_pr === false).map(([id]) => id) })),
    debates: (c.rounds || []).map((d) => ({ round: d.round, pair: d.pair, outcome: d.hold ? 'nobody convinced the other' : d.kind === 'equivalent' ? `${d.winner} and ${d.loser} are equivalent` : `${d.winner} convinced ${d.loser}`, reason: clip(d.reason, 300), arguments: Object.fromEntries(Object.entries(d.arguments || {}).map(([k, v]) => [k, { argument: clip(v.argument || v.argumento, 420), flaws: (v.rival_flaws || v.fallos_rival || []).slice(0, 3) }])) })),
    verdict: c.verdict ? { verdict: c.verdict.verdict, confidence: c.verdict.confidence, majority: c.verdict.members, prInConsensus: c.verdict.prInConsensus, prConceded: c.verdict.prConceded, summary: c.verdict.summary, issues: c.verdict.issues } : null,
  };
}
let overlay = null;
function showConsensus(id) {
  overlay?.remove();
  overlay = document.createElement('div'); overlay.className = 'm-overlay';
  overlay.innerHTML = `<div class="m-sheet"><button class="m-x" type="button" aria-label="Close">×</button><iframe title="Consensus" src="/consenso.html?id=${encodeURIComponent(id)}"></iframe></div>`;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('on'));
  const close = () => { overlay?.classList.remove('on'); const o = overlay; overlay = null; setTimeout(() => o?.remove(), 400); };
  overlay.querySelector('.m-x').onclick = close;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
}

const TOOL_FN = {
  async get_screen() {
    const s = app(); const v = view(); const p = s?.cur && v !== 'home' ? s.cur : null;
    const project = s?.projects?.find((x) => x.id === s.pid);
    return { view: v, project: project?.name, base: s?.base, pullRequest: p ? prBrief(p, allPRs().findIndex((x) => x.id === p.id)) : null, verification: p ? briefOf(s.run?.brief, 'summary') : null, verifyingNow: !!s?.es };
  },
  async list_pull_requests({ direction = 'all', include_old = false } = {}) {
    const all = allPRs();
    const active = (p) => p.yours || p.last || p.running || (!p.behind && Date.now() - new Date(p.date) < 30 * 864e5);
    let list = direction === 'incoming' ? all.filter((p) => !p.yours) : direction === 'outgoing' ? all.filter((p) => p.yours) : all;
    const old = list.filter((p) => !active(p)).length;
    if (!include_old) list = list.filter(active);
    if (view() !== 'home') { call('closeGraph'); await sleep(750); }
    call('highlightLanes', list.map((p) => p.id));
    act(`Showing ${list.length} pull request${list.length === 1 ? '' : 's'}`);
    return { count: list.length, olderNotShown: include_old ? 0 : old, pullRequests: list.slice(0, 25).map((p) => prBrief(p, all.indexOf(p))) };
  },
  async highlight_pull_requests({ ids = [] }) { if (view() !== 'home') { call('closeGraph'); await sleep(750); } call('highlightLanes', ids); return { ok: true }; },
  async open_pull_request({ query }) {
    const p = findPR(query);
    if (!p) return { error: `No pull request matches "${query}".`, available: allPRs().map((x) => x.branch).slice(0, 20) };
    const s = app();
    if (view() !== 'home' && s?.cur?.id === p.id) return { alreadyOpen: true, pullRequest: prBrief(p, allPRs().indexOf(p)) };
    if (view() !== 'home') { call('closeGraph'); await sleep(750); }
    call('highlightLanes', [p.id]); await sleep(350);
    const [x, y] = originOf(p);
    call('highlightLanes', []);
    call('openGraph', p, x, y);
    act(`Opened ${p.branch}`);
    await waitFor(() => app()?.run?.brief || app()?.plan, 8000);
    return { opened: true, pullRequest: prBrief(p, allPRs().indexOf(p)), verification: briefOf(app()?.run?.brief, 'summary'), notVerifiedYet: !app()?.run?.brief };
  },
  async go_home() { document.getElementById('drawer').hidden = true; call('closeGraph'); act('Back home'); return { ok: true }; },
  async get_verification_details({ section = 'summary' } = {}) {
    const s = app();
    if (!s?.cur || view() === 'home') return { error: 'No pull request is open. Open one first.' };
    if (!s.run?.brief) return { verified: false, note: 'This pull request has not been verified yet.', plan: s.plan ? { files: s.plan.totals?.files, added: s.plan.totals?.added, removed: s.plan.totals?.removed } : null };
    return { pullRequest: s.cur.branch, ...briefOf(s.run.brief, section) };
  },
  async open_review() {
    const s = app(); if (!s?.run?.brief) return { error: 'Open a verified pull request first.' };
    call('openReview'); act('Opened review'); return { ok: true };
  },
  async start_verification({ mode = 'quick' } = {}) {
    const s = app(); if (!s?.cur || view() === 'home') return { error: 'Open a pull request first.' };
    s.mode = mode; call('verify'); act(`Verifying (${mode})`); return { started: true, mode };
  },
  async get_consensus() {
    const s = app(); const p = s?.cur && view() !== 'home' ? s.cur : null;
    if (!p) return { error: 'Open a pull request first.' };
    return consensusFor(p);
  },
  async start_consensus() {
    const s = app(); const p = s?.cur && view() !== 'home' ? s.cur : null;
    if (!p) return { error: 'Open a pull request first.' };
    const project = s.projects.find((x) => x.id === s.pid);
    const r = await fetch('/api/consenso', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repo: project.path, branch: p.branch, base: s.base, lang: LANG }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { error: j.error || `Server answered ${r.status}` };
    act('Consensus started'); showConsensus(j.id);
    return { started: true, id: j.id, note: 'Takes about 15 minutes; the live view is open.' };
  },
  async open_consensus() {
    const s = app(); const p = s?.cur && view() !== 'home' ? s.cur : null;
    if (!p) return { error: 'Open a pull request first.' };
    const c = await consensusFor(p);
    if (!c.found) return { error: c.note || 'There is no consensus run for this pull request yet.' };
    showConsensus(c.id); act('Consensus view'); return { opened: true };
  },
  async express({ mood: m }) { express(m); return { ok: true }; },
};

/* ── Gemini Live session ──────────────────────────────────────────────── */
const SYSTEM = `You are the Katse goat: the voice assistant living in the corner of Katse, an app that verifies pull requests by REPRODUCING them instead of reading them (it merges, builds, runs tests red-before/green-after, seeds defects, rewinds each change, and has independent AI agents redo the change blind and debate), then leaves a named human only what could not be checked.
How you talk: warm, quick, professional, a little playful. Spoken answers of 1-3 short sentences; no markdown, no lists, no reading ids or hashes aloud (say branch names naturally). Reply in the language the user speaks (Spanish if they speak Spanish).
How you act: you can see and drive the screen ONLY through tools. Never invent pull requests, numbers or results: call a tool. If the user says "this", "here", "that one", call get_screen. When asked to show, list, open or go somewhere, do it with the tool right away, then say in a few words what you did. For "why is it good/bad", "what was tested and what wasn't", "how did the agents work", use get_verification_details and get_consensus and explain in plain words with concrete files, tests and arguments; be honest about what was NOT verified. Before anything slow (start_verification, start_consensus) ask for a yes. Use express now and then to react (happy for good news, surprised at a bug).`;

async function start(textOnly = false) {
  if (sess) return;
  lastActive = performance.now();
  root.classList.add('on'); face('thinking'); status('Connecting…');
  linesEl.innerHTML = ''; actsEl.innerHTML = ''; userLine = goatLine = null;
  ensureOut(); outCtx.resume?.();
  sess = { ws: null, busy: true, ready: false, pending: [] };
  const me = sess;
  try {
    const tok = await (await fetch('/api/live/token', { method: 'POST' })).json();
    if (!tok.token) throw new Error(tok.error || 'No Live token');
    if (sess !== me) return;
    const ws = new WebSocket(`${tok.url}?access_token=${encodeURIComponent(tok.token)}`);
    me.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ setup: {
      model: `models/${tok.model}`,
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: tok.voice } } } },
      systemInstruction: { parts: [{ text: SYSTEM }] },
      tools: [{ functionDeclarations: TOOLS }],
      inputAudioTranscription: {}, outputAudioTranscription: {},
      realtimeInputConfig: { automaticActivityDetection: { silenceDurationMs: 600 } },
      contextWindowCompression: { slidingWindow: {} },
    } }));
    ws.onmessage = async (ev) => onMessage(me, JSON.parse(typeof ev.data === 'string' ? ev.data : await ev.data.text()));
    ws.onclose = (e) => { if (sess === me) { const bad = e.code !== 1000 && e.code !== 1005; if (bad) { act(`Disconnected: ${e.reason || e.code}`.slice(0, 120), 'bad'); console.warn('Katse Live closed', e.code, e.reason); express('confused', 3000); } stop(true); } };
    ws.onerror = () => {};
    if (!textOnly) {
      try {
        await startMic((chunk) => { if (me.ready && me.ws?.readyState === 1) me.ws.send(JSON.stringify({ realtimeInput: { audio: { data: f32ToB64(chunk), mimeType: 'audio/pcm;rate=16000' } } })); });
      } catch (err) {
        act('Microphone unavailable: type instead', 'warn');
        root.classList.add('typing'); setTimeout(() => typeInput.focus(), 50);
      }
    } else { root.classList.add('typing'); setTimeout(() => typeInput.focus(), 50); }
  } catch (e) {
    status('Could not connect'); act(e.message, 'bad'); express('sad', 3200); stop(true);
  }
}
function stop(keepPanel = false) {
  const s = sess; sess = null;
  if (s?.ws && s.ws.readyState <= 1) { try { s.ws.close(1000); } catch { /* closed */ } }
  stopMic(); flushPlayback();
  face('idle'); root.classList.remove('typing');
  if (!keepPanel) root.classList.remove('on');
  else { status('Ended'); setTimeout(() => { if (!sess) root.classList.remove('on'); }, 3500); }
}
function sendText(text) {
  if (!text.trim()) return;
  if (!sess) { start(true).then(() => waitFor(() => sess?.ready, 8000)).then(() => sendText(text)); return; }
  if (!sess.ready) { sess.pending.push(text); return; }
  userLine = line('you', text); goatLine = null; sess.busy = true;
  sess.ws.send(JSON.stringify({ realtimeInput: { text } }));
}

async function onMessage(me, m) {
  if (sess !== me) return;
  if (m.setupComplete) {
    me.ready = true; me.busy = false; status(mic ? 'Listening' : 'Type a message');
    for (const t of me.pending.splice(0)) sendText(t);
    return;
  }
  if (m.toolCall) {
    me.busy = true; status('Working…');
    const responses = await Promise.all((m.toolCall.functionCalls || []).map(async (fc) => {
      let result;
      try { result = await (TOOL_FN[fc.name] || (() => ({ error: 'unknown tool' })))(fc.args || {}); } catch (e) { result = { error: e.message }; }
      return { id: fc.id, name: fc.name, response: { result } };
    }));
    if (sess === me && me.ws.readyState === 1) me.ws.send(JSON.stringify({ toolResponse: { functionResponses: responses } }));
    return;
  }
  if (m.goAway) { status('Wrapping up…'); return; }
  const sc = m.serverContent; if (!sc) return;
  if (sc.inputTranscription?.text) {
    if (!userLine || goatLine) { userLine = line('you'); goatLine = null; }
    addText(userLine, sc.inputTranscription.text); me.busy = true; status('Thinking…');
  }
  for (const part of sc.modelTurn?.parts || []) {
    if (part.inlineData?.data && /audio/.test(part.inlineData.mimeType || 'audio')) {
      const rate = Number((part.inlineData.mimeType || '').match(/rate=(\d+)/)?.[1]) || 24000;
      play(part.inlineData.data, rate);
    }
  }
  if (sc.outputTranscription?.text) {
    if (!goatLine) goatLine = line('goat');
    addText(goatLine, sc.outputTranscription.text); status('Speaking');
  }
  if (sc.interrupted) { flushPlayback(); status('Listening'); }
  if (sc.turnComplete) {
    me.busy = false; userLine = null; goatLine = null;
    setTimeout(() => { if (sess === me && !speaking()) status(mic ? 'Listening' : 'Type a message'); }, 400);
  }
}

/* ── Input: click, Space, typing ──────────────────────────────────────── */
const typing = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
goatBtn.addEventListener('click', () => (sess ? stop() : start()));
root.querySelector('.m-x').addEventListener('click', () => stop());
typeForm.addEventListener('submit', (e) => { e.preventDefault(); const t = typeInput.value; typeInput.value = ''; sendText(t); });
let spaceDown = false;
addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.repeat || typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
  if (!document.getElementById('modal')?.hidden) return;
  e.preventDefault(); spaceDown = true;
  if (sess) stop(); else start();
}, true);
addEventListener('keyup', (e) => { if (e.code === 'Space' && spaceDown) { e.preventDefault(); spaceDown = false; } }, true);
setTimeout(() => root.classList.add('ready'), 300);

window.KatseMascot = { start, stop, say: sendText, express, tools: TOOL_FN };
