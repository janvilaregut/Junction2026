/* Agent sessions behind commits (Entire). On the branch tree, a commit that came out of an agent session wears that
   agent's mark; hovering shows the prompt that led to it, clicking the mark opens the session: the conversation up to
   that commit (earlier and later work folded), and a button that reopens it in its agent.
   Data: /api/projects/:id/commits (ai per commit), /api/projects/:id/session?sha=… and …/session/resume. */

/* ── Agent marks (simple glyphs, 24×24) ── */
const AGENT_MARKS = [
  [/claude/i, '#d97757', (c) => { let d = ''; for (let i = 0; i < 12; i++) { const a = (i * Math.PI) / 6, r = i % 2 ? 6.5 : 9.5; d += `M${12 + 2.2 * Math.cos(a)} ${12 + 2.2 * Math.sin(a)}L${(12 + r * Math.cos(a)).toFixed(2)} ${(12 + r * Math.sin(a)).toFixed(2)}`; } return `<path d="${d}" stroke="${c}" stroke-width="2.3" stroke-linecap="round"/>`; }],
  [/codex|openai/i, '#f5f5f7', (c) => [0, 60, 120].map((r) => `<ellipse cx="12" cy="12" rx="8.5" ry="3.6" fill="none" stroke="${c}" stroke-width="1.7" transform="rotate(${r} 12 12)"/>`).join('')],
  [/opencode/i, '#f5f5f7', (c) => `<rect x="4" y="4" width="16" height="16" rx="3" fill="none" stroke="${c}" stroke-width="1.8"/><rect x="8.5" y="8.5" width="7" height="7" rx="1" fill="${c}"/>`],
  [/gemini|antigravity/i, '#8ab4f8', (c) => `<path d="M12 2.5C12.6 8 16 11.4 21.5 12C16 12.6 12.6 16 12 21.5C11.4 16 8 12.6 2.5 12C8 11.4 11.4 8 12 2.5Z" fill="${c}"/>`],
  [/cursor/i, '#f5f5f7', (c) => `<path d="M12 3L20 7.5V16.5L12 21L4 16.5V7.5Z M12 3V12L20 7.5 M12 12L4 7.5" fill="none" stroke="${c}" stroke-width="1.6" stroke-linejoin="round"/>`],
  [/copilot/i, '#e3dcf4', (c) => `<rect x="4" y="7" width="16" height="11" rx="5" fill="none" stroke="${c}" stroke-width="1.8"/><circle cx="9.5" cy="12.5" r="1.5" fill="${c}"/><circle cx="14.5" cy="12.5" r="1.5" fill="${c}"/>`],
];
function agentMark(agent, size = 16) {
  const m = AGENT_MARKS.find(([rx]) => rx.test(agent || ''));
  const inner = m ? m[2](m[1]) : `<circle cx="12" cy="12" r="9" fill="none" stroke="#8e8e93" stroke-width="1.6"/><text x="12" y="16" text-anchor="middle" font-size="10" font-family="Inter" fill="#8e8e93">${esc((agent || '?')[0])}</text>`;
  return `<svg class="amark" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;
}
const fmtTok = (n) => (!n ? '' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M tokens` : n >= 1e3 ? `${Math.round(n / 1e3)}k tokens` : `${n} tokens`);
const shortModel = (m) => String(m || '').replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2');

/* ── On the tree: the mark next to a commit, and the lines in the hover cards ── */
function aiBadge(cg, c, x, y, side, scale = 1) {
  const s = c.ai?.[0];
  if (!s) return;
  const r = 9 * scale, cy = side ? y + side * (r + 10 * scale) : y; // side 0: on the line itself
  const b = mk('g', { class: 'aibadge', tabindex: 0, role: 'button', 'aria-label': `Open the ${s.agent} session behind this commit` }, cg);
  mk('circle', { cx: x, cy, r, class: 'aibg' }, b);
  const w = r * 1.35;
  b.insertAdjacentHTML('beforeend', agentMark(s.agent).replace('<svg class="amark"', `<svg class="amark" x="${x - w / 2}" y="${cy - w / 2}"`).replace(/width="16" height="16"/, `width="${w}" height="${w}"`));
  const go = (e) => { e.stopPropagation(); e.preventDefault(); openAiSession(c); };
  b.addEventListener('click', go);
  b.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') go(e); });
}
function aiRow(c) {
  const s = c.ai?.[0];
  if (!s) return '';
  return `<div class="airow">${agentMark(s.agent, 15)}<span><b>${esc(s.agent)}</b>${s.model ? ' · ' + esc(shortModel(s.model)) : ''}</span></div>${s.prompt ? `<div class="aiprompt">“${esc(s.prompt.length > 150 ? s.prompt.slice(0, 149) + '…' : s.prompt)}”</div>` : ''}${s.firstPrompt && s.prompt && s.prompt.length < 48 && s.firstPrompt !== s.prompt ? `<div class="aifirst">Session began with “${esc(s.firstPrompt.length > 90 ? s.firstPrompt.slice(0, 89) + '…' : s.firstPrompt)}”</div>` : ''}<div class="aihint">Click the mark to watch the session</div>`;
}
function aiBranchRow(p) {
  const a = p.ai;
  if (!a) return '';
  return `<div class="airow">${a.agents.map((n) => agentMark(n, 15)).join('')}<span>${a.commits === a.of ? 'Every commit' : `${a.commits} of ${a.of} commits`} made with ${esc(a.agents.join(', '))}</span></div>`;
}

/* ── The session panel ── */
const SX = { sha: null, i: 0, data: null, tok: 0 };
function sessPanel() {
  let el = $('sess');
  if (el) return el;
  el = document.createElement('aside');
  el.id = 'sess'; el.className = 'sess'; el.hidden = true; el.setAttribute('aria-label', 'Agent session');
  el.innerHTML = '<div class="shead"></div><div class="sbody"></div>';
  document.body.appendChild(el);
  return el;
}
const mdLite = (t) => esc(t)
  .replace(/```[\w-]*\n([\s\S]*?)```/g, (_, code) => `<pre>${code}</pre>`)
  .replace(/`([^`\n]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
  .replace(/\n/g, '<br>');
function msgHTML(m) {
  if (m.role === 'user') return `<div class="m u"><div class="who">Prompt</div><div class="txt">${mdLite(m.text)}</div></div>`;
  if (m.role === 'ai') return `<div class="m a"><div class="txt">${mdLite(m.text)}</div></div>`;
  const names = [...new Set(m.items.map((x) => x.name))].slice(0, 4).join(', ');
  return `<details class="m t"><summary><span class="dot"></span>${m.items.length} ${m.items.length === 1 ? 'step' : 'steps'} · ${esc(names)}</summary><ul>${m.items.map((x) => `<li class="${x.ok ? '' : 'bad'}"><b>${esc(x.name)}</b> ${esc(x.what)}</li>`).join('')}</ul></details>`;
}
function renderSession() {
  const d = SX.data, el = sessPanel();
  if (!d || d.none) { el.querySelector('.shead').innerHTML = '<button class="sx" aria-label="Close">×</button>'; el.querySelector('.sbody').innerHTML = '<p class="sempty">No agent session was recorded for this commit.</p>'; el.querySelector('.sx').onclick = closeAiSession; return; }
  const when = d.createdAt ? new Date(d.createdAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
  const meta = [shortModel(d.model), d.prompts ? `${d.prompts} ${d.prompts === 1 ? 'prompt' : 'prompts'}` : '', fmtTok(d.tokens)].filter(Boolean).join(' · ');
  el.querySelector('.shead').innerHTML = `${agentMark(d.agent, 30)}<div class="stit"><b>${esc(d.agent)}</b><small>${esc(meta)}</small></div><button class="sx" aria-label="Close">×</button>`;
  const z = (k) => d.messages.filter((m) => m.zone === k);
  const before = z('before'), mine = z('this'), after = z('after');
  const r = d.resume;
  const act = r ? `<div class="sact"><button class="cta" id="sresume">${r.canOpen ? `Resume in ${esc(r.agent)}` : 'Copy resume command'}</button><code class="scmd" title="${esc(r.cmd)}">${esc(r.cmd.replace(/^cd '[^']*' && /, ''))}</code></div><div class="snote" id="snote">${r.local ? 'This session is on this computer.' : 'Not on this computer: it is restored from the checkpoint first.'}</div>` : '';
  el.querySelector('.sbody').innerHTML = `
    <div class="scommit"><span class="mono">${esc(d.commit.short)}</span><b>${esc(d.commit.subject)}</b><small>${esc(d.commit.author)} · ${esc(when)}${d.others > 1 ? ` · <button class="link" id="snext">session ${SX.i + 1} of ${d.others}</button>` : ''}</small></div>
    ${act}
    <div class="conv">
      ${before.length || d.hidden?.before ? `<details class="fold"><summary>Earlier in this session · ${before.length + (d.hidden?.before || 0)} messages</summary>${d.hidden?.before ? `<p class="sempty">${d.hidden.before} older messages not shown</p>` : ''}${before.map(msgHTML).join('')}</details>` : ''}
      <div class="mine">${mine.map(msgHTML).join('') || '<p class="sempty">The commit was made at the very start of the session.</p>'}</div>
      <div class="cmark"><i></i>${d.located ? 'Committed' : 'Checkpoint'} <span class="mono">${esc(d.commit.short)}</span></div>
      ${after.length ? `<details class="fold"><summary>Later in this session · ${after.length + (d.hidden?.after || 0)} messages</summary>${after.map(msgHTML).join('')}</details>` : ''}
    </div>
    <div class="sfoot">Recorded by Entire · checkpoint <span class="mono">${esc(d.checkpoint)}</span>${d.how === 'attached' ? ' · linked after the commit' : ''}</div>`;
  el.querySelector('.sx').onclick = closeAiSession;
  const nx = $('snext'); if (nx) nx.onclick = () => { SX.i = (SX.i + 1) % d.others; loadSession(); };
  const rb = $('sresume'); if (rb) rb.onclick = resumeAiSession;
  const first = el.querySelector('.mine .m');
  el.querySelector('.sbody').scrollTop = first ? Math.max(0, first.offsetTop - 120) : 0;
}
async function loadSession() {
  const tok = ++SX.tok, el = sessPanel();
  el.querySelector('.sbody').innerHTML = '<p class="sempty">Loading the session…</p>';
  try {
    const d = await api(`/projects/${S.pid}/session?sha=${SX.sha}&i=${SX.i}`);
    if (tok !== SX.tok) return null;
    SX.data = d;
  } catch (e) { if (tok === SX.tok) el.querySelector('.sbody').innerHTML = `<div class="err">${esc(e.message)}</div>`; return null; }
  renderSession();
  return SX.data;
}
/** Open the session behind a commit ({ sha } or a sha). Resolves to what it shows (for the voice). */
async function openAiSession(c, i = 0) {
  const sha = typeof c === 'string' ? c : c?.sha;
  if (!sha) return null;
  $('card')?.classList.remove('on');
  Object.assign(SX, { sha, i, data: null });
  const el = sessPanel();
  el.hidden = false; requestAnimationFrame(() => el.classList.add('on'));
  document.body.classList.add('sesson');
  return loadSession();
}
function closeAiSession() {
  const el = $('sess');
  if (!el || el.hidden) return false;
  SX.tok++;
  el.classList.remove('on'); document.body.classList.remove('sesson');
  setTimeout(() => { if (!el.classList.contains('on')) el.hidden = true; }, 260);
  return true;
}
function aiSessionOpen() { return !!$("sess") && !$("sess").hidden; }
async function resumeAiSession() {
  const d = SX.data, note = $('snote');
  if (!d?.resume) return;
  if (!d.resume.canOpen) {
    try { await navigator.clipboard.writeText(d.resume.cmd); note.textContent = 'Command copied. Paste it in a terminal.'; } catch { note.textContent = d.resume.cmd; }
    return;
  }
  note.textContent = 'Opening Terminal…';
  try {
    const r = await api(`/projects/${S.pid}/session/resume?sha=${SX.sha}&i=${SX.i}`, { body: {} });
    note.textContent = r.opened ? `Opened in Terminal${r.restored ? ' (restored from the checkpoint)' : ''}.` : `Could not open Terminal${r.error ? ': ' + r.error : ''}. Run: ${r.cmd}`;
  } catch (e) { note.textContent = e.message; }
}
// Esc closes the panel before anything else on the page reacts to it.
addEventListener('keydown', (e) => { if (e.key === 'Escape' && aiSessionOpen() && !e.target.closest?.('input, textarea')) { e.stopImmediatePropagation(); closeAiSession(); } }, true);
