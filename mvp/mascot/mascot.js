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
let goatRect = null, goatRectT = 0; // the goat barely moves: read its box at most twice a second, not on every pointer move (each read can force a layout)
addEventListener('pointermove', (e) => {
  if (!goatRect || e.timeStamp - goatRectT > 500) { goatRect = svg.getBoundingClientRect(); goatRectT = e.timeStamp; }
  const r = goatRect;
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
/* A custom property set on every frame restyles the whole goat even when the value is the same: write only changes. */
const lastVar = new Map();
const setVar = (el, k, v) => { const key = (el === svg ? 's' : 'r') + k; if (lastVar.get(key) !== v) { lastVar.set(key, v); el.style.setProperty(k, v); } };
(function loop() {
  cx += (tx - cx) * 0.12; cy += (ty - cy) * 0.12;
  setVar(svg, '--lx', cx.toFixed(2)); setVar(svg, '--ly', cy.toFixed(2));
  let a = 0;
  if (analyser && speaking()) {
    const d = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(d);
    let s = 0; for (let i = 0; i < d.length; i++) s += d[i] * d[i];
    a = Math.min(1, Math.sqrt(s / d.length) * 5.5);
  }
  amp += (a - amp) * (a > amp ? 0.55 : 0.25);
  setVar(svg, '--amp', amp.toFixed(2));
  if (sess) {
    const want = speaking() ? 'talking' : sess.busy ? 'thinking' : 'listening';
    if (base !== want) face(want);
    setVar(root, '--lvl', (want === 'talking' ? amp : micLevel).toFixed(2));
  } else {
    setVar(root, '--lvl', '0');
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
  { name: 'start_verification', description: 'Start the real review of the current pull request: contract, alternatives rebuilt from the base by AI agents, their debate, attacks on the PR and a judge with a 0-10 score. Profiles: quick (90 s, no alternatives), standard (5 min, default), deep (15 min). Ask the user to confirm first.', parameters: T({ profile: { type: 'STRING', enum: ['quick', 'standard', 'deep'] } }) },
  { name: 'get_consensus', description: 'Results of the multi-agent consensus for the current pull request: several Gemini agents solved the same requirement blind, a heatmap compared their code zone by zone with the PR, then they debated in pairs until a consensus. Returns agents, where they agreed/disagreed, each debate argument and who convinced whom, and the verdict (coincide = PR matches the consensus, difiere = the consensus proposes something else, dudoso = no clear majority).', parameters: T() },
  { name: 'start_consensus', description: 'Start a multi-agent consensus check on the current pull request (takes ~15 minutes). Ask the user to confirm first.', parameters: T() },
  { name: 'open_consensus', description: 'Open the raw technical consensus report page (heatmap, full arguments) for the current pull request. For the visual story of the agents use show_agent_debate instead.', parameters: T() },
  { name: 'show_commits', description: 'Unfold one branch in the tree so all its commits show on a long rail (the other branches fold away). Use when the user asks for the commits / history of a branch. query: id, branch, number, a word from its title, or empty for the one open or in focus.', parameters: T({ query: { type: 'STRING' } }) },
  { name: 'show_all_branches', description: 'Fold the commits back and show every branch in the tree again.', parameters: T() },
  { name: 'focus_graph', description: 'Inside the open pull request graph: fly the camera to a node or group and light it up while you talk about it. query: a file name, "Tests", "Builds", "Mutation", a line like "Foo.cs:120", an agent, or a group: "what I must read" (red), "decisions" (yellow), "reproduced" (green), "checks", "files", "agents", "whole" (the core). Call it EVERY time you start explaining a specific part of the graph.', parameters: T({ query: { type: 'STRING' } }, ['query']) },
  { name: 'zoom_graph', description: 'Move the graph camera: "in" (closer), "out" (further), "overview" (back to the whole graph, clears the highlight).', parameters: T({ action: { type: 'STRING', enum: ['in', 'out', 'overview'] } }, ['action']) },
  { name: 'show_agent_debate', description: 'Dive into the animated story of the AI agents for the open pull request: bubbles that solve it blind, compare, argue round by round (they meet, merge when they agree, the convinced one takes the winner\'s colour) and reach a consensus. Use when the user asks how the agents are doing, how they debated, who convinced whom, or to see the agents. It plays by itself; returns the story so you can narrate it. Uses the REAL review run of the PR when it has one (alternatives from the base, their debate, the attacks on the PR and the judge); otherwise a sample (say so).', parameters: T() },
  { name: 'debate_step', description: 'Move through the agents story: next, previous, restart, or jump to a chapter: agents, solve, compare, debate, verdict.', parameters: T({ to: { type: 'STRING', enum: ['next', 'previous', 'restart', 'agents', 'solve', 'compare', 'debate', 'verdict'] } }, ['to']) },
  { name: 'open_agent', description: 'In the agents story: dive into one agent (its bubble fills the screen with its details, arguments and how its debates went). name as shown: in a real run "C1 Hydrogen"/"Hydrogen", "Attacker", "Judge", "The PR"; in a sample run Precise, Steady, Balanced, Curious, Bold.', parameters: T({ name: { type: 'STRING' } }, ['name']) },
  { name: 'close_agent', description: 'Leave the agent detail and go back to all the agents.', parameters: T() },
  { name: 'leave_debate', description: 'Leave the agents story and go back to the pull request graph.', parameters: T() },
  { name: 'express', description: 'Show an emotion with the goat for a moment, to make the conversation lively (e.g. happy when a PR is fine, surprised at a bug).', parameters: T({ mood: { type: 'STRING', enum: ['happy', 'surprised', 'sad', 'confused', 'love', 'bleating', 'thinking'] } }, ['mood']) },
];
TOOLS.push(
  { name: 'fix_it', description: 'Open Fix it mode on the open pull request: the graph dives into a spot and a tree grows from it. Each AI agent that rebuilt the change from the ticket (without seeing the PR) is a branch; when two branches meet the camera zooms in and you see the two agents argue; the attacker crawls in with its test; everything merges into one trunk that ends in the verdict. Use it ONLY when the user asks to fix something, whether something works / is right, or to check or prove it. For explaining or understanding code stay in the graph (focus_graph, show_code). It plays by itself; returns the story (agents, what each said, the verdict) so you can narrate it. Uses the real review run when there is one; otherwise a sample (say so).', parameters: T({ query: { type: 'STRING', description: 'The spot: a line like "318" or "TypeCollector.cs:985", a file name, or empty for the whole change.' } }) },
  { name: 'fix_step', description: 'In Fix it: "skip" jumps to the verdict, "replay" plays the tree again.', parameters: T({ to: { type: 'STRING', enum: ['skip', 'replay'] } }, ['to']) },
  { name: 'leave_fix', description: 'Leave Fix it and go back to the graph.', parameters: T() },
  { name: 'where_to_look', description: 'The spots of code the user should read first (the red "you read it" regions of the graph, where no agent reproduced the PR), lit up in the graph. Use it for "where do I start", "what should I review", "what is risky".', parameters: T() },
  { name: 'show_code', description: 'Fly the graph to one code region and return its code (removed and added lines) and which agents also wrote it. query: a line like "1429" or "TypeCollector.cs:985", or a file name. For understanding, not fixing.', parameters: T({ query: { type: 'STRING' } }, ['query']) },
  { name: 'ask_agent', description: 'What one agent did and said in the review: C1, C2 (agents that rebuilt the change from the base), the PR, the attacker, or the judge.', parameters: T({ name: { type: 'STRING' } }, ['name']) },
  { name: 'look_deeper', description: 'The user wants the change looked at harder: launches a Deep review (up to 15 min, real cost). ASK FOR A YES FIRST.', parameters: T() },
);
const RETIRED = new Set(['show_agent_debate', 'debate_step', 'open_agent', 'close_agent', 'leave_debate']); // Fix it tells that story now
for (let i = TOOLS.length - 1; i >= 0; i--) if (RETIRED.has(TOOLS[i].name)) TOOLS.splice(i, 1);
for (const t of TOOLS) t.behavior = 'BLOCKING';

function allPRs() {
  const s = app(); if (!s) return [];
  return [...(s.prs?.incoming || []).map((p) => ({ ...p, yours: false })), ...(s.prs?.outgoing || []).map((p) => ({ ...p, yours: true }))];
}
function prState(p) { try { return typeof state === 'function' ? state(p).label : (p.last?.laneName || 'Not verified'); } catch { return p.last?.laneName || 'Not verified'; } }
const prBrief = (p, i) => ({ ordinal: i + 1, id: p.id, branch: p.branch, title: p.title, yours: !!p.yours, state: prState(p), verifying: !!p.running, linesForHuman: p.last ? `${p.last.residue} of ${p.last.total}` : null, commitsAhead: p.ahead, date: p.date });
function view() {
  const full = document.getElementById('full'); const drawer = document.getElementById('drawer');
  if (full && !full.hidden && call('fixOpen')) return 'fix';
  if (full && !full.hidden && call('agentOpen')) return 'agent';
  if (full && !full.hidden && call('debateOpen')) return 'debate';
  if (drawer && !drawer.hidden) return 'review';
  if (full && !full.hidden) return 'graph';
  if (app()?.focus) return 'commits';
  return 'home';
}
const inGraph = () => ['graph', 'review', 'debate', 'agent', 'fix'].includes(view());
function graphSummary() {
  const g = typeof G !== 'undefined' ? G : null; if (!g) return null;
  return [...g.nodes.values()].slice(0, 40).map((n) => ({ label: n.label, kind: n.kind, file: n.file, state: n.info }));
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
  if (b.version >= 2 && b.verdict) { // the real review pipeline: judge, attacks, debate, alternatives
    const v = b.verdict;
    out.review = {
      verdict: v.status, label: v.label, score: v.score?.value ?? null, scoreParts: (v.score?.components || []).map((c) => `${c.label}: ${c.earned}/${c.max} (${clip(c.reason, 160)})`), caps: (v.score?.caps || []).map((c) => `max ${c.max}: ${clip(c.reason, 160)}`),
      blockers: (v.pending || []).map((x) => clip(x, 200)), judge: clip(v.semantic?.explanation, 600),
      attacks: (v.findings || []).map((f) => ({ id: f.attack, result: f.classification, hypothesis: clip(f.hypothesis, 260), outcomes: (f.outcomes || []).map((o) => `${o.version}: ${o.outcome}`) })),
      debate: (Array.isArray(b.debate) ? b.debate : []).filter((d) => d.status !== 'incomplete').map((d) => ({ by: d.candidate, model: d.model, round: d.round, strength: clip(d.strength, 220), risk: clip(d.risk, 220), revision: clip(d.revision, 220) })),
      alternatives: (b.candidates || []).map((c) => ({ id: c.id, model: c.model, status: c.status })),
      budget: b.budget ? { profile: b.options?.profile, seconds: Math.round((b.budget.elapsedMs || 0) / 1000), tokens: b.budget.accounting?.observed ?? b.budget.tokens } : null,
      models: b.providers?.models, unavailable: b.providers?.errors,
    };
  }
  const known = new Set(['lane', 'recommendation', 'residue', 'totals', 'timing', 'claims', 'notChecked', 'questions', 'pr', 'cost', 'version', 'verdict', 'contract', 'candidates', 'attacks', 'evidence', 'budget', 'debate', 'input', 'environment', 'finalMissions', 'analysis', 'providers', 'continuation', 'artifactManifest']);
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
    const f = v === 'commits' ? s.focus : null;
    return {
      view: v, project: project?.name, base: s?.base, pullRequest: p ? prBrief(p, allPRs().findIndex((x) => x.id === p.id)) : null, verification: p ? briefOf(s.run?.brief, 'summary') : null, verifyingNow: !!s?.es,
      graphNodes: v === 'graph' || v === 'review' ? graphSummary() : undefined,
      commitsShown: f ? { branch: allPRs().find((x) => x.id === f.id)?.branch, total: f.total, commits: f.commits.map((c) => ({ sha: c.sha.slice(0, 7), subject: c.subject, author: c.author, date: c.date })) } : undefined,
      agentsStory: v === 'debate' || v === 'agent' ? call('debateInfo') : undefined,
      fixIt: v === 'fix' ? call('fixInfo') : undefined,
    };
  },
  async list_pull_requests({ direction = 'all', include_old = false } = {}) {
    const all = allPRs();
    const active = (p) => p.yours || p.last || p.running || (!p.behind && Date.now() - new Date(p.date) < 30 * 864e5);
    let list = direction === 'incoming' ? all.filter((p) => !p.yours) : direction === 'outgoing' ? all.filter((p) => p.yours) : all;
    const old = list.filter((p) => !active(p)).length;
    if (!include_old) list = list.filter(active);
    if (inGraph()) { call('closeGraph'); await sleep(780); }
    call('highlightLanes', list.map((p) => p.id));
    act(`Showing ${list.length} pull request${list.length === 1 ? '' : 's'}`);
    return { count: list.length, olderNotShown: include_old ? 0 : old, pullRequests: list.slice(0, 25).map((p) => prBrief(p, all.findIndex((x) => x.id === p.id))) };
  },
  async highlight_pull_requests({ ids = [] }) { if (inGraph()) { call('closeGraph'); await sleep(780); } call('highlightLanes', ids); return { ok: true }; },
  async open_pull_request({ query }) {
    const p = findPR(query);
    if (!p) return { error: `No pull request matches "${query}".`, available: allPRs().map((x) => x.branch).slice(0, 20) };
    const s = app();
    if (inGraph() && s?.cur?.id === p.id) { call('closeDebate'); return { alreadyOpen: true, pullRequest: prBrief(p, allPRs().findIndex((x) => x.id === p.id)) }; }
    if (inGraph()) { call('closeGraph'); await sleep(780); }
    if (s?.focus && s.focus.id !== p.id) { call('hideCommits'); await sleep(900); }
    if (!s?.focus) { call('highlightLanes', [p.id]); await sleep(420); call('highlightLanes', []); }
    call('openGraph', p); // grows out of the branch's own dot in the tree
    act(`Opened ${p.branch}`);
    await waitFor(() => app()?.run?.brief || app()?.plan, 8000);
    return { opened: true, pullRequest: prBrief(p, allPRs().findIndex((x) => x.id === p.id)), verification: briefOf(app()?.run?.brief, 'summary'), notVerifiedYet: !app()?.run?.brief };
  },
  async go_home() { const was = inGraph(); document.getElementById('drawer').hidden = true; call('closeGraph'); if (!was) call('hideCommits'); act('Back home'); return { ok: true }; },
  async show_commits({ query = '' } = {}) {
    const s = app();
    const p = query ? findPR(query) : allPRs().find((x) => x.id === (s?.focus?.id || s?.cur?.id));
    if (!p) return { error: query ? `No pull request matches "${query}".` : 'Which branch? Give a name.', available: allPRs().map((x) => x.branch).slice(0, 20) };
    const r = await call('showCommits', p.id);
    if (!r) return { error: 'Could not show the commits.' };
    act(`${r.total} commit${r.total === 1 ? '' : 's'} · ${p.branch}`);
    return { branch: p.branch, total: r.total, shown: r.commits.length, commits: r.commits.map((c) => ({ sha: c.sha.slice(0, 7), subject: c.subject, author: c.author, date: c.date })), tip: 'The newest commit is at the right end; open_pull_request opens the branch from there.' };
  },
  async show_all_branches() { if (inGraph()) { call('closeGraph'); await sleep(780); } call('hideCommits'); act('All branches'); return { ok: true }; },
  async focus_graph({ query }) {
    if (!inGraph()) return { error: 'No pull request is open. Open one first.' };
    if (call('debateOpen')) { call('closeDebate'); await sleep(500); }
    if (call('fixOpen')) { call('closeFixit'); await sleep(700); }
    document.getElementById('drawer').hidden = true;
    const list = call('focusGraph', query);
    if (!list) return { error: `Nothing in the graph matches "${query}".`, nodes: graphSummary() };
    act(list.length === 1 ? `Looking at ${list[0].label}` : `Looking at ${list.length} nodes`);
    const nb = (n) => G.links.filter((l) => l.a === n || l.b === n).map((l) => (l.a === n ? l.b : l.a).label);
    return { focused: list.map((n) => ({ label: n.label, kind: n.kind, file: n.file, state: n.info, connectedTo: nb(n).slice(0, 8) })) };
  },
  async zoom_graph({ action }) {
    if (!inGraph()) return { error: 'No pull request is open.' };
    if (call('debateOpen')) { call('closeDebate'); await sleep(400); }
    call('zoomGraph', action === 'overview' ? 'fit' : action);
    return { ok: true };
  },
  async show_agent_debate() {
    if (!inGraph()) return { error: 'Open a pull request first.' };
    document.getElementById('drawer').hidden = true;
    if (!call('openDebate')) return { error: 'Could not open the agents view.' };
    act('Agents debating');
    return call('debateInfo');
  },
  async debate_step({ to }) {
    if (!call('debateOpen')) return { error: 'The agents story is not open. Call show_agent_debate first.' };
    return { chapter: call('debateGo', to) };
  },
  async open_agent({ name: who }) {
    if (!call('debateOpen')) { if (!inGraph()) return { error: 'Open a pull request first.' }; call('openDebate'); await sleep(900); }
    const a = call('openAgent', who);
    if (!a) return { error: `No agent called "${who}".`, agents: call('debateInfo')?.agents?.map((x) => x.name) };
    act(`Inside ${a.name}`);
    const info = call('debateInfo');
    return { agent: a.name, role: a.role, about: a.meta, stats: a.stats, says: a.quote, temperature: a.temperature, debates: info.rounds.filter((r) => r.pair.includes(a.name)), sample: info.sample };
  },
  async close_agent() { return { ok: !!call('closeAgent') }; },
  async fix_it({ query = '' } = {}) {
    if (!inGraph()) return { error: 'Open a pull request first.' };
    if (call('debateOpen')) call('closeDebate');
    document.getElementById('drawer').hidden = true;
    const r = call('openFixit', { query });
    if (!r) return { error: 'Could not open Fix it.' };
    act(r.focus ? `Fix it · ${r.focus}` : 'Fix it');
    return { ...r, note: r.sample ? 'This branch has no full review yet: the tree is a SAMPLE. Say so, and offer start_verification.' : 'Real review run. Narrate it while it plays: who rebuilt it, the debate, the attack, the verdict.' };
  },
  async fix_step({ to }) { if (!call('fixOpen')) return { error: 'Fix it is not open. Call fix_it first.' }; return { ok: !!call(to === 'skip' ? 'fixSkip' : 'fixReplay') }; },
  async leave_fix() { call('closeFixit'); act('Back to the graph'); return { ok: true }; },
  async where_to_look() {
    if (!inGraph()) return { error: 'Open a pull request first.' };
    if (call('fixOpen')) { call('closeFixit'); await sleep(700); }
    document.getElementById('drawer').hidden = true;
    const list = call('focusGraph', 'what I must read');
    if (!list) return { error: 'No red regions: nothing is left only for the human, or the branch is not verified yet.', nodes: graphSummary() };
    act(`${list.length} spot${list.length === 1 ? '' : 's'} to read`);
    return { read: list.map((n) => ({ where: `${n.file || ''}:${n.start ?? ''}`, why: n.info })), tip: 'Explain the first one in plain words; show_code opens its code.' };
  },
  async show_code({ query }) {
    if (!inGraph()) return { error: 'Open a pull request first.' };
    if (call('fixOpen')) { call('closeFixit'); await sleep(700); }
    const list = call('focusGraph', query);
    const s = app(), r = s?.run;
    const m = String(query || '').match(/(?:([\w.-]+\.\w+)\s*)?:?\s*(\d+)/);
    try {
      const data = await (await fetch(r?.brief?.version >= 2 ? `/api/projects/${s.pid}/runs/${r.id}/versions` : `/api/projects/${s.pid}/versions?pr=${encodeURIComponent(s.cur.id)}`)).json();
      const q = String(query || '').toLowerCase();
      const pool = (data.regions || []).filter((x) => !m?.[1] && !m ? x.file.toLowerCase().includes(q) : !m[1] || x.file.toLowerCase().includes(m[1].toLowerCase()));
      const reg = m ? pool.sort((a, b) => Math.abs(a.start - m[2]) - Math.abs(b.start - m[2]))[0] : pool[0];
      if (!reg) return { error: `No code region matches "${query}".`, focused: !!list };
      act(`${reg.file.split('/').pop()}:${reg.start}`);
      return { where: `${reg.file}:${reg.start}-${reg.end}`, alsoWrittenBy: reg.who, code: [...reg.removed.map((x) => '- ' + x), ...reg.added.map((x) => '+ ' + x)].slice(0, 30).join('\n') };
    } catch (e) { return { error: e.message, focused: !!list }; }
  },
  async ask_agent({ name: who }) {
    const b = app()?.run?.brief;
    if (!b || !(b.version >= 2)) return { error: 'This branch has no full review yet: no agents to ask.' };
    const w = String(who || '').toLowerCase();
    if (/judge|juez/.test(w)) return { agent: 'judge', score: b.verdict?.score?.value ?? null, verdict: b.verdict?.status, says: b.verdict?.semantic?.explanation || null };
    if (/attack|atac/.test(w)) return { agent: 'attacker', attacks: (b.attacks || []).map((a) => ({ hypothesis: a.hypothesis, status: a.status })), findings: (b.verdict?.findings || []).map((f) => ({ classification: f.classification, outcomes: (f.outcomes || []).map((o) => `${o.version}: ${o.outcome}`) })) };
    if (/\bpr\b|original/.test(w)) { const e = (b.evidence || []).filter((x) => x.version === 'original').pop(); return { agent: 'the PR', tests: e ? `${e.status} (${e.ran} tests)` : null }; }
    const c = (b.candidates || []).find((x) => w.includes(x.id.toLowerCase()) || w.includes(String(x.model).split('-').pop()));
    if (!c) return { error: `No agent called "${who}".`, agents: (b.candidates || []).map((x) => x.id) };
    const deb = (Array.isArray(b.debate) ? b.debate : b.debate?.entries || []).filter((d) => d.candidate === c.id);
    const e = (b.evidence || []).filter((x) => x.version === c.id).pop();
    return { agent: c.id, model: c.model, status: c.status, summary: c.summary, tests: e ? `${e.status} (${e.ran} tests)` : null, said: deb.map((d) => ({ round: d.round, strength: d.strength, risk: d.risk, revision: d.revision })) };
  },
  async look_deeper() {
    const s = app(); if (!s?.cur || !inGraph()) return { error: 'Open a pull request first.' };
    s.profile = 'deep';
    const started = (await call('verify')) !== false;
    if (started) act('Deep review started');
    return { started };
  },
  async leave_debate() { call('closeDebate'); act('Back to the graph'); return { ok: true }; },
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
  async start_verification({ profile = 'standard' } = {}) {
    const s = app(); if (!s?.cur || !inGraph()) return { error: 'Open a pull request first.' };
    if (call('debateOpen')) call('closeDebate');
    s.profile = ['quick', 'standard', 'deep'].includes(profile) ? profile : 'standard';
    const started = (await call('verify')) !== false;
    if (started) act(`Reviewing (${s.profile})`);
    return started ? { started: true, profile: s.profile, note: 'Live progress shows in the bottom bar; when it ends the graph, the score and the agents story update with the real result.' } : { started: false, note: 'A verification is already running or starting, or no pull request is open.' };
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
    const r = await fetch('/api/consenso', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repo: project.path, branch: p.branch, base: s.base, lang: 'en' }) });
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
The idea you explain and show: Katse gives the same ticket to AI agents who rebuild the change from the base WITHOUT seeing the PR. Where their versions converge with the PR, that code is reproduced and can be trusted; where only the PR wrote code, that is what the human reads (red nodes in the graph). An attacker runs a test against every version and a judge scores the PR. So instead of reading line by line, you guide the user spot by spot.
How to guide: a pull request always opens on its graph. To EXPLAIN or help understand code, stay in the graph: focus_graph and zoom_graph move the camera, where_to_look lights the spots to read, show_code gives a region's code. When the user asks to FIX something, or whether something works / is right, call fix_it (with the spot if they named one): the agents' tree grows, they argue at each junction and it ends in a verdict; narrate it as it plays. For "what did C2 say", call ask_agent. For "look harder", confirm and call look_deeper. "Show me the commits of this branch" means show_commits. Never invent regions or results: they come from the tools.
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
// Space keeps its native meaning on focused controls (Verify, Review, a residue <summary>, a branch with role=button).
const control = (el) => el && el !== document.body && el !== goatBtn && !!el.closest?.('button, summary, a[href], [role="button"], input, textarea, select, [contenteditable="true"]');
goatBtn.addEventListener('click', () => (sess ? stop() : start()));
root.querySelector('.m-x').addEventListener('click', () => stop());
typeForm.addEventListener('submit', (e) => { e.preventDefault(); const t = typeInput.value; typeInput.value = ''; sendText(t); });
let spaceDown = false;
addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.repeat || typing(e.target) || control(document.activeElement) || e.metaKey || e.ctrlKey || e.altKey) return;
  if (!document.getElementById('modal')?.hidden) return;
  e.preventDefault(); spaceDown = true;
  if (sess) stop(); else start();
}, true);
addEventListener('keyup', (e) => { if (e.code === 'Space' && spaceDown) { e.preventDefault(); spaceDown = false; } }, true);
setTimeout(() => root.classList.add('ready'), 300);

window.KatseMascot = { start, stop, say: sendText, express, tools: TOOL_FN };
