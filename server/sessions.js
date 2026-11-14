// AI provenance: which agent session produced a commit. Read straight from git, from the checkpoints Entire stores
// in refs/entire/checkpoints/* (no Entire binary needed to read them). A checkpoint names its commits in two ways:
// the commit carries an `Entire-Checkpoint: <id>` trailer (captured live), or the checkpoint's metadata lists it in
// `linked_commits` (a session attached afterwards to a commit that was already pushed: history is not rewritten).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git } from './git.js';
import { spawn } from 'node:child_process';
import { run, sha256 } from './util.js';

const CACHE = new Map(); // repo -> { key, bySha: Map<sha, ai[]>, byId: Map<id, checkpoint> }
const FETCHED = new Map(); // repo -> last fetch of checkpoint refs (ms)

/** Read many git objects in one process. specs: ["<obj>:<path>", …] → Map<spec, string|null>. */
async function catFiles(repo, specs) {
  const outMap = new Map();
  if (!specs.length) return outMap;
  const r = await new Promise((resolve) => {
    const p = spawn('git', ['cat-file', '--batch'], { cwd: repo });
    const chunks = [];
    p.stdout.on('data', (d) => chunks.push(d));
    p.on('close', () => resolve(Buffer.concat(chunks)));
    p.on('error', () => resolve(Buffer.alloc(0)));
    p.stdin.end(specs.join('\n') + '\n');
  });
  let at = 0;
  for (const spec of specs) {
    const nl = r.indexOf(10, at);
    if (nl < 0) break;
    const head = r.subarray(at, nl).toString();
    at = nl + 1;
    const m = head.match(/^([0-9a-f]+) \w+ (\d+)$/);
    if (!m) { outMap.set(spec, null); continue; }
    const size = Number(m[2]);
    const text = new String(r.subarray(at, at + size).toString('utf8')); // eslint-disable-line no-new-wrappers
    text.oid = m[1];
    outMap.set(spec, text);
    at += size + 1;
  }
  return outMap;
}
const json = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

/** The first prompt a person typed (skipping tool notices and injected skill text). */
function firstPrompt(text) {
  const parts = String(text || '').split(/\n\n---\n\n/).map((s) => s.trim()).filter(Boolean);
  const human = parts.find((s) => !/^<[\w-]+>/.test(s) && !/^Base directory for this skill/.test(s)) || parts[0] || '';
  return human.replace(/\s+/g, ' ').slice(0, 280);
}

/** Fetch the checkpoints teammates pushed (fast-forward only: a local checkpoint with more sessions is never lost). */
export async function syncCheckpoints(repo) {
  if (Date.now() - (FETCHED.get(repo) || 0) < 5 * 60_000) return;
  FETCHED.set(repo, Date.now());
  await git(repo, ['fetch', '--quiet', 'origin', 'refs/entire/checkpoints/*:refs/entire/checkpoints/*'], { allowFail: true, timeout: 60_000 });
}

/** Commit sha → the agent sessions behind it, built once per state of the refs. */
async function index(repo) {
  const refs = (await git(repo, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/entire/checkpoints'], { allowFail: true })).stdout
    .split('\n').filter(Boolean).map((l) => { const [obj, ref] = l.split(' '); return { obj, ref, id: ref.split('/').pop() }; });
  const tips = (await git(repo, ['for-each-ref', '--format=%(objectname)', 'refs/heads', 'refs/remotes'], { allowFail: true })).stdout;
  const key = sha256(refs.map((r) => r.obj).join(',') + '|' + tips);
  const hit = CACHE.get(repo);
  if (hit && hit.key === key) return hit;

  const roots = await catFiles(repo, refs.map((r) => `${r.obj}:metadata.json`));
  const byId = new Map();
  const want = [];
  for (const r of refs) {
    const m = json(roots.get(`${r.obj}:metadata.json`));
    if (!m) continue;
    const cp = { ...r, linked: (m.linked_commits || []).map((c) => c.sha).filter(Boolean), sessions: (m.sessions || []).map((s, i) => ({ i, paths: s })), files: m.files_touched || [], tokens: m.token_usage || null };
    byId.set(r.id, cp);
    for (const s of cp.sessions) want.push(`${r.obj}:${s.paths.metadata.replace(/^\//, '')}`, `${r.obj}:${s.paths.prompt.replace(/^\//, '')}`);
  }
  const blobs = await catFiles(repo, want);
  for (const cp of byId.values()) {
    cp.sessions = cp.sessions.map(({ i, paths }) => {
      const m = json(blobs.get(`${cp.obj}:${paths.metadata.replace(/^\//, '')}`)) || {};
      const t = m.session_token_usage || m.token_usage || {};
      return {
        checkpoint: cp.id, index: i, paths,
        agent: m.agent || 'Agent', model: m.model || null, sessionId: m.session_id || null, createdAt: m.created_at || null,
        turns: m.session_metrics?.turn_count ?? m.checkpoints_count ?? null,
        tokens: (t.input_tokens || 0) + (t.output_tokens || 0) + (t.cache_creation_tokens || 0) + (t.cache_read_tokens || 0) || null,
        branch: m.branch || null, start: m.compact_transcript_start || 0,
        prompt: firstPrompt(blobs.get(`${cp.obj}:${paths.prompt.replace(/^\//, '')}`)),
      };
    });
  }

  const bySha = new Map();
  const add = (sha, cp, how) => { if (!sha || !cp) return; const l = bySha.get(sha) || []; for (const s of cp.sessions) if (!l.some((x) => x.checkpoint === s.checkpoint && x.index === s.index)) l.push({ ...s, how }); bySha.set(sha, l); };
  for (const cp of byId.values()) for (const sha of cp.linked) add(sha, cp, 'attached');
  if (byId.size) {
    const log = (await git(repo, ['log', '--branches', '--remotes', '--format=%H%x1f%(trailers:key=Entire-Checkpoint,valueonly,separator=%x2c)'], { allowFail: true, timeout: 60_000 })).stdout;
    for (const line of log.split('\n')) {
      const [sha, ids] = line.split('\x1f');
      for (const id of (ids || '').split(',').map((s) => s.trim()).filter(Boolean)) add(sha, byId.get(id), 'captured');
    }
  }
  for (const l of bySha.values()) l.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  const built = { key, bySha, byId };
  CACHE.set(repo, built);
  return built;
}

/* ── Where in the session a commit was made ──
   One session often makes several commits. Entire stores the whole conversation in each checkpoint, so the commit's
   own part is found here: the tool call that ran `git commit` and printed this commit's sha ends it, and the previous
   such call in the same session starts it. The prompt shown for a commit is the last thing the person asked before it. */
const PARSED = new Map(); // blob id → parsed lines (a few, most recent)
const COMMIT = /\bgit\b(?:\s+-[cC]\s+\S+)*\s+commit\b(?!-)/;
const injected = (t) => /^<[a-z][\w-]*[ >]/.test(t) || (t.length > 1500 && /^#{1,2} /.test(t)) || /^Base directory for this skill/.test(t) || /^\[Request interrupted/.test(t) || /^(This session is being continued from a previous conversation|Another Claude session sent a message|Caveat: The messages below were generated)/.test(t);
const resultText = (r) => (typeof r === 'string' ? r : typeof r?.output === 'string' ? r.output : JSON.stringify(r?.output ?? r ?? ''));
const inputOf = (b) => (typeof b.input === 'string' ? json(b.input) || { text: b.input } : b.input || {});
async function linesOf(repo, cp, s) {
  const spec = `${cp.obj}:${(s.paths.compact_transcript || s.paths.transcript).replace(/^\//, '')}`;
  const raw = (await catFiles(repo, [spec])).get(spec);
  if (!raw) return [];
  if (PARSED.has(raw.oid)) return PARSED.get(raw.oid);
  const lines = String(raw).split('\n').filter((l) => l.trim()).map(json).filter(Boolean);
  for (const d of lines) d.commits = (d.content || []).filter((b) => b.type === 'tool_use' && COMMIT.test(String(inputOf(b).command || '')) && b.result?.status !== 'error').map((b) => resultText(b.result));
  PARSED.set(raw.oid, lines);
  if (PARSED.size > 6) PARSED.delete(PARSED.keys().next().value);
  return lines;
}
// Entire redacts secrets on capture, but not all (an NVIDIA key slipped through once): mask well-known key shapes again.
const KEYS = new RegExp([
  'AIza[0-9A-Za-z_-]{30,}', 'AQ\\.[0-9A-Za-z_-]{30,}', '\\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}', '\\bgh[pousr]_[A-Za-z0-9]{30,}',
  '\\bnvapi-[A-Za-z0-9_-]{30,}', '\\bdc_[0-9a-f]{64,}', '\\bxox[baprs]-[A-Za-z0-9-]{10,}', '\\bhf_[A-Za-z0-9]{30,}',
  // and the exact values of the keys this server has loaded
  ...Object.entries(process.env).filter(([k, v]) => /KEY|TOKEN|SECRET|PASSWORD/i.test(k) && v && v.length >= 12).map(([, v]) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
].join('|'), 'g');
const garbled = (t) => (t.match(/[\uFFFD\u0000-\u0008\u000E-\u001F]/g) || []).length > Math.max(3, t.length * 0.02);
/** What a person typed on this line of the transcript, or ''. */
function humanText(d) {
  if (d.type !== 'user') return '';
  for (const b of d.content || []) { const t = typeof b.text === 'string' ? b.text.trim() : ''; if (t && !injected(t) && !garbled(t)) return t; }
  return '';
}
function momentOf(lines, sha, start) {
  const short = sha.slice(0, 7);
  const rx = new RegExp(`(?:\\[[^\\]\\s]+(?: \\(root-commit\\))? |^|\\n)${short}[0-9a-f]*(?:\\] | )`);
  let end = -1;
  for (let i = 0; i < lines.length && end < 0; i++) if (lines[i].commits.some((t) => rx.test(t))) end = i;
  let from = Math.min(start || 0, lines.length);
  if (end >= 0) { from = 0; for (let i = end - 1; i >= 0; i--) if (lines[i].commits.length) { from = i + 1; break; } }
  const last = end >= 0 ? end : lines.length - 1;
  let prompt = '', first = '', at = -1;
  for (let i = last; i >= 0 && !prompt; i--) { prompt = humanText(lines[i]); at = i; }
  if (prompt && end >= 0) from = Math.min(from, at); // the commit's part starts at what the person asked for it
  for (let i = 0; i < lines.length && !first; i++) first = humanText(lines[i]);
  const one = (t) => t.replace(KEYS, 'REDACTED').replace(/\s+/g, ' ').slice(0, 280);
  const prompts = lines.reduce((n, d) => n + (humanText(d) ? 1 : 0), 0);
  return { from, end: last, found: end >= 0, prompt: one(prompt), first: one(first), prompts };
}

const light = (s) => ({ checkpoint: s.checkpoint, index: s.index, agent: s.agent, model: s.model, turns: s.turns, tokens: s.tokens, createdAt: s.createdAt, prompt: s.prompt, how: s.how });
async function withMoment(repo, ix, sha, s) {
  const lines = await linesOf(repo, ix.byId.get(s.checkpoint), s);
  const m = momentOf(lines, sha, s.start);
  return { ...light(s), prompt: m.prompt || s.prompt, firstPrompt: m.first || s.prompt };
}

/** Sessions behind one commit (light form, for the hover card). */
export async function aiOf(repo, sha) {
  const ix = await index(repo);
  return Promise.all((ix.bySha.get(sha) || []).map((s) => withMoment(repo, ix, sha, s)));
}
/** Same, for many commits at once: sha → sessions. */
export async function aiOfMany(repo, shas, { moments = true } = {}) {
  const ix = await index(repo);
  const o = {};
  for (const sha of shas) {
    const l = ix.bySha.get(sha);
    if (l?.length) o[sha] = moments ? await Promise.all(l.map((s) => withMoment(repo, ix, sha, s))) : l.map(light);
  }
  return o;
}
/** A branch at a glance: how many of its commits came out of an agent session, and which agents. */
export async function aiOfRange(repo, range) {
  const ix = await index(repo);
  if (!ix.bySha.size) return null;
  const shas = (await git(repo, ['rev-list', '--max-count=200', range], { allowFail: true })).stdout.split('\n').filter(Boolean);
  const hit = shas.filter((s) => ix.bySha.has(s));
  if (!hit.length) return null;
  return { commits: hit.length, of: shas.length, agents: [...new Set(hit.flatMap((s) => ix.bySha.get(s).map((x) => x.agent)))] };
}

/* ── Watching a session: the compact transcript, as a conversation ──
   zone: 'before' (earlier in the session), 'this' (what led to this commit), 'after' (later work in the session). */
const cut = (s, n) => { const t = String(s || '').replace(KEYS, 'REDACTED'); return t.length > n ? t.slice(0, n) + '…' : t; };
function toolGist(b) {
  const i = inputOf(b);
  const what = i.description || i.command || i.file_path || i.path || i.pattern || i.url || i.query || i.skill || i.prompt || i.text || '';
  return { name: String(b.name || 'tool').replace(/^mcp__.*__/, ''), what: cut(String(what).replace(/\s+/g, ' '), 160), ok: b.result?.status !== 'error' };
}

export async function sessionOf(repo, sha, which = 0) {
  const ix = await index(repo);
  const list = ix.bySha.get(sha) || [];
  const s = list[Math.min(Math.max(0, Number(which) || 0), list.length - 1)];
  if (!s) return { none: true };
  const cp = ix.byId.get(s.checkpoint);
  const lines = await linesOf(repo, cp, s);
  const m = momentOf(lines, sha, s.start);
  const msgs = [];
  lines.forEach((d, i) => {
    const zone = i < m.from ? 'before' : i <= m.end ? 'this' : 'after';
    for (const b of d.content || []) {
      if (d.type === 'user' && typeof b.text === 'string') {
        const t = b.text.trim();
        if (!t || injected(t) || garbled(t)) continue;
        msgs.push({ role: 'user', text: cut(t, 6000), ts: d.ts, zone });
      } else if (d.type === 'assistant' && b.type === 'tool_use') {
        const last = msgs[msgs.length - 1];
        const g = toolGist(b);
        if (last?.role === 'tools' && last.zone === zone) last.items.push(g); else msgs.push({ role: 'tools', items: [g], ts: d.ts, zone });
      } else if (d.type === 'assistant' && typeof b.text === 'string' && b.text.trim()) {
        msgs.push({ role: 'ai', text: cut(b.text.trim(), 6000), ts: d.ts, zone });
      }
    }
  });
  for (const x of msgs) if (x.role === 'tools' && x.items.length > 60) x.items = [...x.items.slice(0, 60), { name: '…', what: `${x.items.length - 60} more`, ok: true }];
  // Long sessions: everything of this commit, and only the nearest of the rest.
  const mine = msgs.filter((x) => x.zone === 'this');
  const before = msgs.filter((x) => x.zone === 'before'), after = msgs.filter((x) => x.zone === 'after');
  const commit = (await git(repo, ['log', '-1', '--format=%h%x1f%s%x1f%an%x1f%aI', sha], { allowFail: true })).stdout.trim().split('\x1f');
  return {
    ...light(s), prompt: m.prompt || s.prompt, firstPrompt: m.first || s.prompt, prompts: m.prompts, located: m.found,
    sessionId: s.sessionId, branch: s.branch, files: cp.files, others: list.length,
    commit: { sha, short: commit[0], subject: commit[1], author: commit[2], date: commit[3] },
    messages: [...before.slice(-150), ...mine.slice(-600), ...after.slice(0, 80)],
    hidden: { before: Math.max(0, before.length - 150), after: Math.max(0, after.length - 80) },
    resume: await resumeInfo(repo, s),
  };
}

/* ── Reopening a session in its agent ──
   Claude Code keeps a session as ~/.claude/projects/<cwd with every non-alphanumeric as "-">/<id>.jsonl and resumes it
   with `claude --resume <id>` from that same folder. If the session is not on this computer, the checkpoint's full
   transcript (secrets already redacted by Entire) is restored there first, which is what `entire session resume` does. */
const CLAUDE = path.join(os.homedir(), '.claude', 'projects');
const enc = (dir) => dir.replace(/[^a-zA-Z0-9]/g, '-');
function localClaude(id) {
  try {
    for (const d of fs.readdirSync(CLAUDE)) {
      const f = path.join(CLAUDE, d, `${id}.jsonl`);
      if (fs.existsSync(f)) return f;
    }
  } catch { /* no Claude Code here */ }
  return null;
}
function cwdOf(file) {
  try {
    const fd = fs.openSync(file, 'r'); const b = Buffer.alloc(200_000); const n = fs.readSync(fd, b, 0, b.length, 0); fs.closeSync(fd);
    const m = b.subarray(0, n).toString().match(/"cwd":"((?:[^"\\]|\\.)*)"/);
    return m ? JSON.parse(`"${m[1]}"`) : null;
  } catch { return null; }
}
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
async function resumeInfo(repo, s) {
  const id = String(s.sessionId || '');
  if (!/^[\w-]{6,80}$/.test(id)) return null;
  if (/claude/i.test(s.agent)) {
    const file = localClaude(id);
    const cwd = (file && cwdOf(file)) || repo;
    return { agent: s.agent, local: !!file, cwd, cmd: `cd ${q(fs.existsSync(cwd) ? cwd : repo)} && claude --resume ${id}`, canOpen: process.platform === 'darwin' };
  }
  if (/codex/i.test(s.agent)) return { agent: s.agent, local: false, cmd: `cd ${q(repo)} && codex resume ${id}`, canOpen: false };
  if (/opencode/i.test(s.agent)) return { agent: s.agent, local: false, cmd: `cd ${q(repo)} && opencode --session ${id}`, canOpen: false };
  return null;
}

/** Open the session in a new Terminal window (macOS), restoring its log from the checkpoint first if needed. */
export async function resumeSession(repo, sha, which = 0, { open = true } = {}) {
  const ix = await index(repo);
  const list = ix.bySha.get(sha) || [];
  const s = list[Math.min(Math.max(0, Number(which) || 0), list.length - 1)];
  if (!s) throw new Error('No agent session for this commit');
  const info = await resumeInfo(repo, s);
  if (!info) throw new Error(`${s.agent} sessions cannot be reopened from here`);
  if (/claude/i.test(s.agent) && !info.local) {
    const cp = ix.byId.get(s.checkpoint);
    const spec = `${cp.obj}:${s.paths.transcript.replace(/^\//, '')}`;
    const full = (await catFiles(repo, [spec])).get(spec);
    if (!full) throw new Error('The checkpoint has no full transcript to restore');
    const dir = path.join(CLAUDE, enc(repo));
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `${s.sessionId}.jsonl`);
    if (!fs.existsSync(f)) fs.writeFileSync(f, String(full).replace(KEYS, 'REDACTED'), { mode: 0o600 }); // never restore a key Entire missed
    info.cmd = `cd ${q(repo)} && claude --resume ${s.sessionId}`;
    info.restored = true;
  }
  if (!info.canOpen || !open) return { ...info, opened: false };
  // A throwaway .command script opened like a double click: the default terminal runs it, no Automation permission needed.
  const script = path.join(os.tmpdir(), `katse-resume-${s.sessionId}.command`);
  fs.writeFileSync(script, `#!/bin/zsh -l\nrm -f ${q(script)}\n${info.cmd}\n`, { mode: 0o700 });
  const r = await run('open', [script], { timeout: 15_000 });
  return { ...info, opened: r.code === 0, error: r.code ? (r.stderr || r.stdout).trim() : undefined };
}
