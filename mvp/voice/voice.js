/* Katse voice. Say "Hey Reviewer" (or "Hey Katse"), press Space or click the dot bottom-right: a white aura lights up
   around the screen and a real-time voice session with Gemini Live (gemini-3.8-live) starts, through a single-use
   ephemeral token from /api/live/token. The model drives the app with the tools in tools.js. When nobody has spoken
   for a few seconds (or the user says goodbye) the session closes and the aura fades.
   Wake word: the browser's speech recognition listens in the background only for the wake phrase; it is stopped
   while a conversation is on, so the conversation itself goes only to Gemini.
   Audio: mic → 16 kHz PCM16 chunks of ~32 ms; model audio 24 kHz PCM16 → scheduled AudioBuffers; the aura follows
   the mic level while listening and the playback level while talking; barge-in flushes playback on `interrupted`. */
import { createTools } from './tools.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IDLE_MS = 8000;        // after the last word from either side, the conversation closes
const FIRST_IDLE_MS = 12000; // a little longer right after waking, before the user has said anything
const SPEECH = 0.35;         // mic level that counts as the user speaking
const WAKE_LANG = (() => { try { return localStorage.getItem('katse.wakeLang') || 'en-US'; } catch { return 'en-US'; } })();
const HEY = '(?:hey|hi|high|hay|ey|ei|a|oye|ok(?:ay)?|hello|hola)';
const WAKE = [
  new RegExp(`\\b${HEY}[\\s,.!]+(?:re ?view(?:er|ers|a)?|rebiu?er|riviewer)\\b`),
  new RegExp(`\\b${HEY}[\\s,.!]+(?:katse|katze|kat ?se|cats|kats|catsy|katsy|kate'?s|cat'?s|cutsie|kazi|catsay|gotsa)\\b`),
];
let sess = null; // the live Gemini session, if any

/* ── DOM ─────────────────────────────────────────────────────────────── */
const aura = document.createElement('div');
aura.className = 'aura'; aura.setAttribute('aria-hidden', 'true');
aura.innerHTML = '<i class="a-bloom"></i><i class="a-soft"></i><i class="a-mid"></i><i class="a-loud"></i><i class="a-sweep"></i><i class="a-sweep b"></i><i class="a-rim"></i>';
const cap = document.createElement('div');
cap.className = 'vcap'; cap.setAttribute('role', 'status'); cap.setAttribute('aria-live', 'polite');
cap.innerHTML = '<p class="v-you"></p><p class="v-ai"></p><span class="v-hint"></span><span class="v-act"></span><form class="v-type" hidden><input type="text" placeholder="Type instead…" aria-label="Type a message" autocomplete="off"><button type="submit" aria-label="Send">↵</button></form>';
const dot = document.createElement('button');
dot.type = 'button'; dot.className = 'vdot';
document.body.append(aura, cap, dot);
const youEl = cap.querySelector('.v-you'), aiEl = cap.querySelector('.v-ai'), hintEl = cap.querySelector('.v-hint'), actEl = cap.querySelector('.v-act');
const typeForm = cap.querySelector('.v-type'), typeInput = typeForm.querySelector('input');

const tail = (s, n = 260) => (s.length > n ? '…' + s.slice(-n).replace(/^\S*\s/, '') : s);
let youText = '', aiText = '', actTimer = 0;
function hint(t = '') { hintEl.textContent = t; }
function you(t, add = false) { youText = add ? youText + t : t; youEl.textContent = tail(youText.trim(), 160); }
function ai(t, add = false) { aiText = add ? aiText + t : t; aiEl.textContent = tail(aiText.trim()); }
function act(text, tone = '') {
  actEl.textContent = text; actEl.className = `v-act show ${tone}`;
  clearTimeout(actTimer); actTimer = setTimeout(() => actEl.classList.remove('show'), 4500);
}
function showTyping(on) { typeForm.hidden = !on; if (on) setTimeout(() => typeInput.focus(), 60); }

/* ── Audio: playback (24 kHz) with its level ─────────────────────────── */
let outCtx = null, analyser = null, nextAt = 0; const sources = new Set();
function ensureOut() {
  if (outCtx) return;
  outCtx = new AudioContext({ sampleRate: 24000 });
  analyser = outCtx.createAnalyser(); analyser.fftSize = 512; analyser.connect(outCtx.destination);
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
  const src = outCtx.createBufferSource(); src.buffer = buf; src.connect(analyser);
  const at = Math.max(outCtx.currentTime + 0.03, nextAt);
  src.start(at); nextAt = at + buf.duration; sources.add(src);
  src.onended = () => sources.delete(src);
}
function flushPlayback() { for (const s of sources) { try { s.stop(); } catch { /* already stopped */ } } sources.clear(); nextAt = 0; }
const speaking = () => !!outCtx && outCtx.currentTime < nextAt - 0.02;
// Browsers keep audio muted until the page gets a click or a key. Unlock it on the first one, so a conversation
// started by the wake word can be heard.
const unlock = () => { ensureOut(); if (outCtx.state === 'suspended') outCtx.resume().catch(() => {}); };
addEventListener('pointerdown', unlock, true); addEventListener('keydown', unlock, true);

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
    for (; pos < f.length; pos += ratio) { const i = Math.floor(pos), t = pos - i; acc.push(f[i] * (1 - t) + (f[i + 1] ?? f[i]) * t); } // linear resample to 16 kHz
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

/* ── Animation loop: aura level, state and the idle close ─────────────── */
let lvl = 0, lastLvl = '', looping = false;
function setState(s) { if (aura.dataset.state !== s) aura.dataset.state = s; }
function loop() {
  const now = performance.now();
  let want = 0;
  if (sess) {
    const me = sess, talk = speaking();
    let a = 0;
    if (talk) {
      const d = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(d);
      let s = 0; for (let i = 0; i < d.length; i++) s += d[i] * d[i];
      a = Math.min(1, Math.sqrt(s / d.length) * 5);
    }
    const state = !me.ready ? 'connecting' : talk ? 'talking' : me.busy ? 'thinking' : 'listening';
    setState(state);
    want = state === 'talking' ? 0.3 + a * 0.7 : state === 'listening' ? Math.min(1, micLevel * 1.1) : 0.22 + 0.12 * Math.sin(now / 260);
    if (talk || me.busy || micLevel > SPEECH || typeInput.value) me.lastAct = now;
    const idle = !typeForm.hidden ? 20000 : me.heard ? IDLE_MS : FIRST_IDLE_MS; // typing is slower than talking
    if (me.ending && !talk && now - Math.max(me.ending, me.lastAudio) > 1400) stop();
    else if (me.ready && !me.busy && !talk && now - me.lastAct > idle) stop();
  }
  lvl += (want - lvl) * (want > lvl ? 0.35 : 0.12);
  const v = lvl.toFixed(2);
  if (v !== lastLvl) { lastLvl = v; aura.style.setProperty('--lvl', v); }
  if (sess || lvl > 0.01) requestAnimationFrame(loop); else looping = false;
}
function kick() { if (!looping) { looping = true; requestAnimationFrame(loop); } }

/* ── Gemini Live session ──────────────────────────────────────────────── */
const SYSTEM = `You are Katse's voice: the assistant of Katse, an app that verifies pull requests by REPRODUCING them instead of reading them (it merges, builds, runs tests red-before/green-after, seeds defects, rewinds each change, and has independent AI agents redo the change blind and debate), then leaves a named human only what could not be checked. The user wakes you by saying "Hey Reviewer" or "Hey Katse"; while you are on, a white light glows around their screen.
How you talk: warm, quick, professional. Spoken answers of 1-3 short sentences; no markdown, no lists, no reading ids or hashes aloud (say branch names naturally). Reply in the language the user speaks (Spanish if they speak Spanish). If the user only woke you, wait for them: do not greet first.
The idea you explain and show: a pull request opens as a DEPENDENCY GRAPH of the functions it changed. The size of a node is how much code depends on it; its colour is what mathematics can claim without running anything and without AI: PROVED (ringed green: a proof that the edit cannot change behaviour, same tokens or only local variables renamed), CLEARED (pale green: nothing flagged, not a proof), UNCERTAIN (amber) and RISKY (red: a check failed or high exposure). Grey nodes are unchanged neighbours. Only what mathematics cannot settle goes to AI agents, one function at a time: three agents rebuild that function blind from the requirement, their versions are compared with the PR, and a difference only counts if a sentence of the requirement decides it. A node turns green when they reproduce it, red (with the fix) when they wrote it differently, and stays amber when a person must decide. So the user never reads line by line: they go spot by spot until the graph is green, then sign.
How to guide: stay in the graph to explain: graph_overview says what mathematics settled, where_to_look lights the open spots in order, focus_graph and zoom_graph move the camera, show_code gives a region's code. When the user asks to review, check or fix a spot, or whether it is right, call open_review with that spot (empty = the most pressing one): the agents' tree grows out of the node and ends in a verdict card; narrate it. "Review everything" means review_all. If the user says they read a spot and accept it, call mark_read. The agents are shown ONLY as that tree of branches: there is no other agents page. The full review of the whole pull request (build, tests, attacks, judge, minutes) is start_verification: ask for a yes first. For "what did C2 say", call ask_agent. For "look harder", confirm and call look_deeper. "Show me the commits of this branch" means show_commits; "zoom into / enlarge this branch" ("amplíame la rama") means zoom_branch. Never invent functions or results: they come from the tools.
How you act: you can see and drive the screen ONLY through tools. Never invent pull requests, numbers or results: call a tool. If the user says "this", "here", "that one", call get_screen. When asked to show, list, open or go somewhere, do it with the tool right away, then say in a few words what you did. For "why is it good/bad", "what was tested and what wasn't", "how did the agents work", use graph_overview and get_verification_details and explain in plain words with concrete files, tests and arguments; be honest about what was NOT verified. Before anything slow (start_verification) ask for a yes. When the user says goodbye, thanks that's all, or that they are done, call end_conversation.`;

const { TOOLS, TOOL_FN } = createTools({ act, end: () => { if (sess) sess.ending = performance.now(); } });
for (const t of TOOLS) t.behavior = 'BLOCKING';

/** Starts a conversation. capture: a promise for what the user said right after the wake word (sent as the first
    message; the mic opens once it settles so those words are not heard twice). */
async function start({ textOnly = false, capture = null } = {}) {
  if (sess) return;
  if (!capture) wakeStop();
  const now = performance.now();
  sess = { ws: null, busy: true, ready: false, pending: [], lastAct: now, lastAudio: 0, heard: false, ending: 0 };
  const me = sess;
  you(''); ai(''); hint(''); actEl.textContent = ''; showTyping(false); newTurn = true;
  setState('connecting'); aura.classList.add('on'); cap.classList.add('on');
  lvl = 1; kick(); // a flash of light as it opens
  unlock();
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
    ws.onclose = (e) => {
      if (sess !== me) return;
      if (e.code !== 1000 && e.code !== 1005) { act(`Disconnected: ${e.reason || e.code}`.slice(0, 120), 'bad'); console.warn('Katse Live closed', e.code, e.reason); }
      stop();
    };
    ws.onerror = () => {};
    const said = capture ? await Promise.race([capture, sleep(2500).then(() => '')]) : '';
    wakeStop();
    if (sess !== me) return;
    if (said) sendText(said);
    if (!textOnly) {
      try {
        await startMic((chunk) => { if (me.ready && me.ws?.readyState === 1) me.ws.send(JSON.stringify({ realtimeInput: { audio: { data: f32ToB64(chunk), mimeType: 'audio/pcm;rate=16000' } } })); });
        if (sess !== me) stopMic();
      } catch {
        act('Microphone unavailable: type instead', 'warn'); showTyping(true);
      }
    } else showTyping(true);
  } catch (e) {
    act(e.message, 'bad'); setTimeout(() => { if (sess === me) stop(); }, 2600);
  }
}
function stop() {
  const s = sess; sess = null;
  if (s?.ws && s.ws.readyState <= 1) { try { s.ws.close(1000); } catch { /* closed */ } }
  stopMic(); flushPlayback(); showTyping(false);
  aura.classList.remove('on'); cap.classList.remove('on');
  kick();
  setTimeout(() => { if (!sess) { you(''); ai(''); hint(''); } }, 900);
  setTimeout(() => { if (!sess) wakeStart(); }, 600);
}
function sendText(text) {
  if (!text.trim()) return;
  if (!sess) { start({ textOnly: true }).then(() => sendText(text)); return; }
  if (!sess.ready) { sess.pending.push(text); return; }
  you(text); ai(''); hint(''); sess.busy = true; sess.heard = true; sess.lastAct = performance.now();
  sess.ws.send(JSON.stringify({ realtimeInput: { text } }));
}

let newTurn = true; // the next transcription starts a new exchange on screen
async function onMessage(me, m) {
  if (sess !== me) return;
  me.lastAct = performance.now();
  if (m.setupComplete) {
    me.ready = true; me.busy = false;
    if (!me.pending.length) hint(mic || !typeForm.hidden ? '' : 'Listening…');
    for (const t of me.pending.splice(0)) sendText(t);
    if (outCtx?.state === 'suspended') act('Click anywhere to hear me', 'warn');
    return;
  }
  if (m.toolCall) {
    me.busy = true;
    const responses = await Promise.all((m.toolCall.functionCalls || []).map(async (fc) => {
      let result;
      try { result = await (TOOL_FN[fc.name] || (() => ({ error: 'unknown tool' })))(fc.args || {}); } catch (e) { result = { error: e.message }; }
      return { id: fc.id, name: fc.name, response: { result } };
    }));
    if (sess === me && me.ws.readyState === 1) me.ws.send(JSON.stringify({ toolResponse: { functionResponses: responses } }));
    return;
  }
  const sc = m.serverContent; if (!sc) return;
  if (sc.inputTranscription?.text) {
    if (newTurn) { you(''); ai(''); newTurn = false; }
    you(sc.inputTranscription.text, true); hint(''); me.busy = true; me.heard = true;
  }
  for (const part of sc.modelTurn?.parts || []) {
    if (part.inlineData?.data && /audio/.test(part.inlineData.mimeType || 'audio')) {
      const rate = Number((part.inlineData.mimeType || '').match(/rate=(\d+)/)?.[1]) || 24000;
      play(part.inlineData.data, rate); me.lastAudio = performance.now();
    }
  }
  if (sc.outputTranscription?.text) { ai(sc.outputTranscription.text, true); newTurn = true; }
  if (sc.interrupted) { flushPlayback(); newTurn = true; }
  if (sc.turnComplete) { me.busy = false; newTurn = true; }
}

/* ── Wake word ────────────────────────────────────────────────────────── */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const wake = { rec: null, want: true, fails: 0, hit: null };
function wakeLabel() {
  const on = !!wake.rec;
  dot.dataset.wake = on ? 'on' : 'off';
  dot.dataset.label = on ? 'Say “Hey Reviewer” · Space' : 'Talk to Katse · Space';
  dot.setAttribute('aria-label', on ? 'Listening for “Hey Reviewer”. Click or press Space to talk now.' : 'Talk to Katse (Space)');
}
function matchWake(text) {
  const t = ` ${String(text).toLowerCase().replace(/[“”"¡!¿?]/g, ' ')} `;
  for (const re of WAKE) { const m = re.exec(t); if (m) return { after: t.slice(m.index + m[0].length).replace(/^[\s,.]+/, '').trim() }; }
  return null;
}
function wakeStart() {
  if (!SR || !wake.want || sess || wake.rec) return wakeLabel();
  const rec = new SR();
  rec.continuous = true; rec.interimResults = true; rec.lang = WAKE_LANG; rec.maxAlternatives = 3;
  rec.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (wake.hit) { // already woken: wait for the end of this phrase to catch the command said with it
        if (i === wake.hit.index && r.isFinal) { const m = matchWake(r[0].transcript); wake.hit.done(m ? m.after : ''); }
        continue;
      }
      for (let k = 0; k < r.length; k++) {
        const m = matchWake(r[k].transcript); if (!m) continue;
        let done; const capture = new Promise((res) => { done = res; });
        wake.hit = { index: i, done };
        if (r.isFinal) done(m.after);
        if (!sess) start({ capture });
        break;
      }
    }
  };
  rec.onerror = (e) => { if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { wake.want = false; console.info('Katse: wake word unavailable (' + e.error + ')'); } };
  rec.onstart = () => { wake.fails = 0; };
  rec.onend = () => {
    if (wake.rec !== rec) return;
    wake.rec = null; wake.hit?.done(''); wake.hit = null; wakeLabel();
    if (wake.want && !sess) { wake.fails++; setTimeout(wakeStart, Math.min(8000, 250 * 2 ** Math.min(wake.fails, 5))); }
  };
  try { rec.start(); wake.rec = rec; } catch { /* already started */ }
  wakeLabel();
}
function wakeStop() {
  const rec = wake.rec; wake.rec = null;
  wake.hit?.done(''); wake.hit = null;
  if (rec) { try { rec.abort(); } catch { /* stopped */ } }
  wakeLabel();
}
// Start listening for the wake word at once when the mic is already allowed; otherwise on the first click or key,
// so the browser's permission prompt comes after something the user did.
(async () => {
  wakeLabel();
  if (!SR) return;
  let granted = false;
  try { granted = (await navigator.permissions.query({ name: 'microphone' })).state === 'granted'; } catch { /* no permissions API */ }
  if (granted) return wakeStart();
  const first = () => { removeEventListener('pointerdown', first, true); removeEventListener('keydown', first, true); setTimeout(wakeStart, 50); };
  addEventListener('pointerdown', first, true); addEventListener('keydown', first, true);
})();

/* ── Input: Space, Escape, the dot, typing ────────────────────────────── */
const typing = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
// Space keeps its native meaning on focused controls (Verify, Review, a residue <summary>, a branch with role=button).
const control = (el) => el && el !== document.body && el !== dot && !!el.closest?.('button, summary, a[href], [role="button"], input, textarea, select, [contenteditable="true"]');
dot.addEventListener('click', () => (sess ? stop() : start()));
typeForm.addEventListener('submit', (e) => { e.preventDefault(); const t = typeInput.value; typeInput.value = ''; sendText(t); });
let spaceDown = false;
addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && sess && !typing(e.target)) { e.preventDefault(); stop(); return; }
  if (e.code !== 'Space' || e.repeat || typing(e.target) || control(document.activeElement) || e.metaKey || e.ctrlKey || e.altKey) return;
  if (!document.getElementById('modal')?.hidden) return;
  e.preventDefault(); spaceDown = true;
  if (sess) stop(); else start();
}, true);
addEventListener('keyup', (e) => { if (e.code === 'Space' && spaceDown) { e.preventDefault(); spaceDown = false; } }, true);

/** Pretends the wake word was heard, e.g. KatseVoice.wake('hey reviewer, open the first pull request'). */
function fakeWake(text = 'hey reviewer') {
  const m = matchWake(text); if (!m) return false;
  if (!sess) start({ textOnly: !navigator.mediaDevices, capture: Promise.resolve(m.after) });
  else if (m.after) sendText(m.after);
  return true;
}
window.KatseVoice = { start, stop, say: sendText, wake: fakeWake, matchWake, tools: TOOL_FN, get state() { return sess ? aura.dataset.state : 'off'; } };
window.KatseMascot = window.KatseVoice; // older name, still used in notes and tests
