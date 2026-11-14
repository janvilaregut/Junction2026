#!/usr/bin/env node
/* Entire for this repository, reproducible and never global.
   Entire (entire.io) records the agent session (prompts, conversation, model, tokens) behind every commit and keeps
   it in git, in refs/entire/checkpoints/*. Katse shows it on each commit of the branch tree.

     npm run entire              install + enable + backfill (what a new clone needs)
     npm run entire -- install   the pinned Entire CLI, checksum-verified, into tools/entire/bin/ (git-ignored)
     npm run entire -- enable    turn capture on in every worktree of this clone (hooks call the repo's own binary)
     npm run entire -- backfill  link past commits to the Claude Code sessions on this computer that made them
     npm run entire -- status    what is captured, what is still only local, and a secret check
     npm run entire -- scrub     replace API keys with REDACTED in checkpoints, Entire's local state and transcripts
     npm run entire -- push      upload local checkpoints to origin, after the secret check passes

   Nothing touches the global PATH or ~/.local: the binary lives in this clone, and the hooks point at it.
   Backfill never rewrites history: a commit already pushed gets its session through a linking checkpoint
   (`entire session attach --commit`), and commits not pushed yet are left for a later run. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';

const VERSION = '0.13.4';
const SUMS = { // from https://github.com/entireio/cli/releases/download/v0.13.4/checksums.txt
  darwin_arm64: '1ab8e96b596d4ece40ecf2173d53855676ee859d2dfc5c1b459157e192b18c9e',
  darwin_amd64: '0b8f05dffcde1c17f06edde8fac582e9b4509d215b7eaca80546ed346356c94f',
  linux_arm64: '4d702394fc32986d23a3e0d1e37e42698994418580be62629baea578e47647e5',
  linux_amd64: 'c58879f9000764714b1e9d9c6803cb613de1d3e7e61f75563815618918f2128b',
  windows_arm64: 'd943237ec5ff9cc845ec932987c7f7edb5acb0823684385df965c5ba9011cb81',
  windows_amd64: '80395e33c3500410e17026a4d83c3c832109d85cc6793b73f42909b929e86b70',
};

const sh = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 << 20, ...opts });
  return { code: r.status ?? 1, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() || (r.error ? String(r.error.message) : '') };
};
const gitc = (args, cwd = process.cwd()) => sh('git', args, { cwd });
const die = (m) => { console.error(`✗ ${m}`); process.exit(1); };

const common = gitc(['rev-parse', '--path-format=absolute', '--git-common-dir']);
if (common.code) die('Run this inside the repository.');
const GIT_DIR = common.out;
const REPO = path.dirname(GIT_DIR); // the main checkout, shared by every worktree
const HERE = gitc(['rev-parse', '--show-toplevel']).out;
const BIN_DIR = path.join(REPO, 'tools', 'entire', 'bin');
const EXE = path.join(BIN_DIR, process.platform === 'win32' ? 'entire.exe' : 'entire');
const env = { ...process.env, PATH: BIN_DIR + path.delimiter + process.env.PATH, ENTIRE_TELEMETRY: 'false' };
const entire = (args, cwd = HERE) => sh(EXE, args, { cwd, env });

/* ── install ── */
async function install() {
  if (fs.existsSync(EXE) && entire(['version']).out.includes(`Entire CLI ${VERSION}`)) return console.log(`✓ Entire ${VERSION} already in ${path.relative(REPO, BIN_DIR)}/`);
  const osName = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[process.platform];
  const arch = { arm64: 'arm64', x64: 'amd64' }[process.arch];
  const key = `${osName}_${arch}`;
  if (!SUMS[key]) die(`No Entire build for ${process.platform}/${process.arch}.`);
  const file = `entire_${key}.${osName === 'windows' ? 'zip' : 'tar.gz'}`;
  const url = `https://github.com/entireio/cli/releases/download/v${VERSION}/${file}`;
  console.log(`↓ ${url}`);
  const res = await fetch(url);
  if (!res.ok) die(`Download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = crypto.createHash('sha256').update(buf).digest('hex');
  if (got !== SUMS[key]) die(`Checksum mismatch for ${file}: expected ${SUMS[key]}, got ${got}. Nothing installed.`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'entire-'));
  try {
    fs.writeFileSync(path.join(tmp, file), buf);
    const x = sh('tar', ['-xf', path.join(tmp, file), '-C', tmp]);
    if (x.code) die(`Could not unpack ${file}: ${x.err}`);
    fs.mkdirSync(BIN_DIR, { recursive: true });
    const name = path.basename(EXE);
    fs.copyFileSync(path.join(tmp, name), EXE);
    fs.chmodSync(EXE, 0o755);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log(`✓ Entire ${VERSION} (sha256 verified) → ${path.relative(REPO, EXE)}`);
}
const need = () => { if (!fs.existsSync(EXE)) die('Entire is not installed in this repo yet: npm run entire -- install'); };

/* ── enable ── */
const worktrees = () => gitc(['worktree', 'list', '--porcelain']).out.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9)).filter((d) => fs.existsSync(d));
function excludeLocally(patterns) { // Entire's files are per clone: keep them out of commits without touching .gitignore
  const f = path.join(GIT_DIR, 'info', 'exclude');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const cur = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  const add = patterns.filter((p) => !cur.split('\n').includes(p));
  if (add.length) fs.appendFileSync(f, `${cur.endsWith('\n') || !cur ? '' : '\n'}# Entire (npm run entire)\n${add.join('\n')}\n`);
}
/* Claude Code's hooks look for `entire` on PATH. They go to .claude/settings.local.json (git-ignored), pointed at this
   repo's binary, so no tracked file changes; a tracked .claude/settings.json is left exactly as committed. */
function moveHooksToLocal(dir) {
  const shared = path.join(dir, '.claude', 'settings.json');
  const local = path.join(dir, '.claude', 'settings.local.json');
  if (!fs.existsSync(shared)) return;
  const tracked = !gitc(['ls-files', '--error-unmatch', '.claude/settings.json'], dir).code;
  const j = JSON.parse(fs.readFileSync(shared, 'utf8'));
  const l = fs.existsSync(local) ? JSON.parse(fs.readFileSync(local, 'utf8')) : {};
  const prefix = `PATH=${JSON.stringify(BIN_DIR)}:"$PATH" `;
  const isEntire = (h) => typeof h.command === 'string' && /\bentire hooks\b/.test(h.command);
  l.hooks = l.hooks || {};
  for (const [event, groups] of Object.entries(j.hooks || {})) {
    for (const g of groups) {
      const mine = (g.hooks || []).filter(isEntire);
      if (!mine.length) continue;
      const dst = (l.hooks[event] = l.hooks[event] || []);
      let to = dst.find((x) => (x.matcher || '') === (g.matcher || ''));
      if (!to) dst.push((to = { ...(g.matcher !== undefined ? { matcher: g.matcher } : {}), hooks: [] }));
      for (const h of mine) {
        const cmd = h.command.startsWith('PATH=') ? h.command : prefix + h.command;
        if (!to.hooks.some((x) => x.command === cmd)) to.hooks.push({ ...h, command: cmd });
      }
      if (!tracked) g.hooks = g.hooks.filter((h) => !isEntire(h));
    }
    if (!tracked) j.hooks[event] = groups.filter((g) => g.hooks?.length);
    if (!tracked && !j.hooks[event].length) delete j.hooks[event];
  }
  fs.writeFileSync(local, JSON.stringify(l, null, 2) + '\n');
  if (tracked) return;
  if (j.hooks && !Object.keys(j.hooks).length) delete j.hooks;
  if (Object.keys(j).length) fs.writeFileSync(shared, JSON.stringify(j, null, 2) + '\n'); else fs.rmSync(shared);
}
function enable() {
  need();
  excludeLocally(['.entire/', '.claude/settings.local.json']);
  for (const dir of worktrees()) {
    const r = entire(['enable', '--agent', 'claude-code', '--local', '--telemetry=false', '--skip-push-sessions', '--absolute-git-hook-path', '--agent-help-skill=false'], dir);
    if (r.code) { console.log(`✗ ${path.relative(REPO, dir) || '.'}: ${r.err || r.out}`); continue; }
    entire(['configure', '--checkpoint-push-policy', 'manual'], dir);
    moveHooksToLocal(dir);
    const sf = path.join(dir, '.entire', 'settings.local.json'); // Entire redacts these shapes too from now on
    const st = fs.existsSync(sf) ? JSON.parse(fs.readFileSync(sf, 'utf8')) : {};
    st.redaction = { ...(st.redaction || {}), custom_redactions: { ...(st.redaction?.custom_redactions || {}), ...SHAPES } };
    fs.writeFileSync(sf, JSON.stringify(st, null, 2) + '\n');
    console.log(`✓ capture on in ${path.relative(REPO, dir) || '(main checkout)'}`);
  }
  console.log('  New Claude Code sessions are recorded from their next start. Checkpoints stay local until `npm run entire -- push`.');
}

/* ── backfill: which local Claude Code session made each commit ──
   `git commit` prints "[<branch> <sha>] <subject>"; that line sits in the session's transcript as the tool's output.
   The earliest session that printed it is the one that made the commit. */
async function backfill({ dry }) {
  need();
  const root = path.join(os.homedir(), '.claude', 'projects');
  const prefix = REPO.replace(/[^a-zA-Z0-9]/g, '-');
  const dirs = fs.existsSync(root) ? fs.readdirSync(root).filter((d) => d === prefix || d.startsWith(prefix + '-')).map((d) => path.join(root, d)) : [];
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.jsonl')) files.push(p); } };
  dirs.forEach(walk);
  const seen = new Map(); // sha7 → { session, ts, text }
  const COMMIT = /\bgit\b(?:\s+-[cC]\s+\S+)*\s+commit\b(?!-)/;
  const SHA = /\[[^\]\s]+(?: \(root-commit\))? ([0-9a-f]{7,12})\] ([^\n]{1,80})|(?:^|\n)([0-9a-f]{7,12}) ([^\n]{1,80})/g;
  const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x?.text || '').join('\n') : '');
  for (const f of files) {
    const rel = path.relative(dirs.find((d) => f.startsWith(d)), f).split(path.sep);
    const session = rel[0].replace(/\.jsonl$/, ''); // subagent transcripts live under <session>/subagents/
    const commits = new Set(); // ids of tool calls that ran `git commit`
    const rl = readline.createInterface({ input: fs.createReadStream(f), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.includes('tool_use')) continue;
      let d; try { d = JSON.parse(line); } catch { continue; }
      for (const c of Array.isArray(d.message?.content) ? d.message.content : []) {
        if (c.type === 'tool_use' && typeof c.input?.command === 'string' && COMMIT.test(c.input.command)) commits.add(c.id);
        if (c.type !== 'tool_result' || !commits.has(c.tool_use_id)) continue;
        for (const m of textOf(c.content).matchAll(SHA)) {
          const short = m[1] || m[3], text = (m[2] || m[4]).trim();
          const prev = seen.get(short);
          if (!prev || (d.timestamp || '') < prev.ts) seen.set(short, { session, ts: d.timestamp || '', text });
        }
      }
    }
  }
  // Keep only real commits of this repo whose subject matches what the session printed.
  const found = [];
  for (const [short, v] of seen) {
    const r = gitc(['log', '-1', '--format=%H%x1f%s%x1f%cI', `${short}^{commit}`], REPO);
    if (r.code) continue;
    const [sha, subject, date] = r.out.split('\x1f');
    if (!subject || !subject.startsWith(v.text.slice(0, Math.min(24, subject.length)))) continue;
    found.push({ sha, subject, date, session: v.session });
  }
  const { aiOfMany } = await import(new URL('../server/sessions.js', import.meta.url));
  const have = await aiOfMany(REPO, found.map((c) => c.sha), { moments: false });
  const pushed = new Set(gitc(['rev-list', '--remotes'], REPO).out.split('\n'));
  const todo = found.filter((c) => !have[c.sha]).sort((a, b) => a.date.localeCompare(b.date));
  const ready = todo.filter((c) => pushed.has(c.sha));
  const later = todo.filter((c) => !pushed.has(c.sha));
  console.log(`${files.length} Claude Code transcripts · ${found.length} commits made in them · ${found.length - todo.length} already linked · ${ready.length} to link now${later.length ? ` · ${later.length} not pushed yet (run again after pushing)` : ''}`);
  let ok = 0;
  for (const c of ready) {
    if (dry) { console.log(`  would link ${c.sha.slice(0, 7)} ${c.subject.slice(0, 60)}  ← ${c.session}`); continue; }
    const r = entire(['session', 'attach', c.session, '--agent', 'claude-code', '--commit', c.sha, '--force'], REPO);
    // Entire exits non-zero only to warn that the checkpoint is not uploaded yet: that is the plan here.
    const linked = /Attached session|Created checkpoint|Added to checkpoint/.test(r.out + r.err);
    if (!linked) console.log(`  ✗ ${c.sha.slice(0, 7)} ${c.subject.slice(0, 50)}: ${(r.err || r.out).split('\n').pop()}`);
    else { ok++; console.log(`  ✓ ${c.sha.slice(0, 7)} ${c.subject.slice(0, 60)}`); }
  }
  if (!dry && ready.length) console.log(`✓ ${ok} commits linked to their sessions (local checkpoints; history unchanged).`);
}

/* ── secrets: well-known key shapes plus the values in the repo's .env files; values are only held in memory ──
   Entire's own redaction misses some formats (an NVIDIA "dc_…" key went through), so these shapes are also given to
   Entire as custom redactions on enable, checked before any upload, and scrubbed from what is already stored. */
const SHAPES = {
  'gemini-aiza': 'AIza[0-9A-Za-z_-]{30,}',
  'gemini-aq': 'AQ\\.[0-9A-Za-z_-]{30,}',
  'openai-anthropic': '\\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}',
  'github': '\\bgh[pousr]_[A-Za-z0-9]{30,}',
  'nvidia-nvapi': '\\bnvapi-[A-Za-z0-9_-]{30,}',
  'nvidia-dc': '\\bdc_[0-9a-f]{64,}',
  'slack': '\\bxox[baprs]-[A-Za-z0-9-]{10,}',
  'huggingface': '\\bhf_[A-Za-z0-9]{30,}',
};
function envValues() {
  const values = [];
  for (const f of ['.env', '.env.local']) {
    const p = path.join(REPO, f);
    if (!fs.existsSync(p)) continue;
    for (const l of fs.readFileSync(p, 'utf8').split('\n')) { const v = l.match(/^\s*[\w.]+\s*=\s*["']?([^"'\s#]+)/)?.[1]; if (v && v.length >= 12 && !/^https?:/.test(v)) values.push(v); }
  }
  return values;
}
const secretRx = () => new RegExp([...Object.values(SHAPES), ...envValues().map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))].join('|'), 'g');
const blob = (oid) => spawnSync('git', ['cat-file', 'blob', oid], { cwd: REPO, encoding: 'latin1', maxBuffer: 256 << 20 }).stdout || ''; // bytes as-is, untrimmed
function treeFiles(commit) {
  return gitc(['ls-tree', '-r', commit], REPO).out.split('\n').filter(Boolean).map((l) => { const [meta, file] = l.split('\t'); const [mode, , oid] = meta.split(' '); return { mode, oid, file }; });
}
function secretCheck(objs) {
  const rx = secretRx();
  const bad = [];
  for (const o of objs) {
    const files = treeFiles(o.obj).filter((f) => { rx.lastIndex = 0; return rx.test(blob(f.oid)); }).map((f) => f.file);
    if (files.length) bad.push({ id: o.id, files });
  }
  return bad;
}

/* scrub: rewrite every local checkpoint that holds a secret (one new commit, same message, secrets → REDACTED; the old
   versions are dropped and their loose objects deleted), and mask secrets in place in Entire's local state and in this
   repo's Claude Code transcripts (same length, so a session still writing its transcript is not disturbed). */
function maskInPlace(file, rx) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { return 0; }
  const text = buf.toString('latin1');
  let n = 0, fd = null;
  rx.lastIndex = 0;
  for (const m of text.matchAll(rx)) {
    const v = m[0];
    const repl = Buffer.from(v.length >= 8 ? 'REDACTED'.padEnd(v.length, '*') : '*'.repeat(v.length), 'latin1');
    fd ??= fs.openSync(file, 'r+');
    fs.writeSync(fd, repl, 0, repl.length, m.index);
    n++;
  }
  if (fd !== null) fs.closeSync(fd);
  return n;
}
function scrub() {
  const rx = secretRx();
  const has = (t) => { rx.lastIndex = 0; return rx.test(t); };
  let rewritten = 0;
  const dropped = new Set();
  for (const c of checkpoints()) {
    const files = treeFiles(c.obj);
    const history = gitc(['rev-list', c.obj], REPO).out.split('\n').filter(Boolean);
    const leaked = new Set();
    for (const commit of history) for (const f of treeFiles(commit)) if (has(blob(f.oid))) leaked.add(f.oid);
    if (!leaked.size) continue;
    const idx = path.join(os.tmpdir(), `entire-scrub-${process.pid}.idx`);
    const env2 = { ...process.env, GIT_INDEX_FILE: idx };
    try {
      const lines = files.map((f) => {
        let oid = f.oid;
        const t = blob(f.oid);
        if (has(t)) oid = sh('git', ['hash-object', '-w', '--stdin'], { cwd: REPO, input: Buffer.from(t.replace(rx, 'REDACTED'), 'latin1') }).out;
        return `${f.mode} blob ${oid}\t${f.file}`;
      });
      sh('git', ['update-index', '--add', '--index-info'], { cwd: REPO, env: env2, input: lines.join('\n') + '\n' });
      const tree = sh('git', ['write-tree'], { cwd: REPO, env: env2 }).out;
      const msg = gitc(['log', '-1', '--format=%B', c.obj], REPO).out;
      const commit = sh('git', ['commit-tree', tree, '-m', msg], { cwd: REPO }).out;
      const u = gitc(['update-ref', c.ref, commit, c.obj], REPO);
      if (u.code) { console.log(`✗ ${c.id}: ${u.err}`); continue; }
      leaked.forEach((o) => dropped.add(o));
      rewritten++;
      console.log(`✓ checkpoint ${c.id}: secrets replaced with REDACTED${c.pushed ? ' (origin still has the old version: delete it there too)' : ''}`);
    } finally { fs.rmSync(idx, { force: true }); }
  }
  // The old blobs are unreachable now: delete them if they are loose objects (packed ones need a gc).
  if (dropped.size) {
    const reach = new Set(gitc(['rev-list', '--all', '--objects'], REPO).out.split('\n').map((l) => l.split(' ')[0]));
    let gone = 0, packed = 0;
    for (const o of dropped) {
      if (reach.has(o)) continue;
      const f = path.join(GIT_DIR, 'objects', o.slice(0, 2), o.slice(2));
      if (fs.existsSync(f)) { fs.rmSync(f, { force: true }); gone++; }
      if (!gitc(['cat-file', '-e', o], REPO).code) packed++;
    }
    // Packed ones: rebuild the packs from what is still reachable (loose objects other sessions are writing are untouched).
    if (packed) { gitc(['repack', '-a', '-d', '-q'], REPO); packed = [...dropped].filter((o) => !reach.has(o) && !gitc(['cat-file', '-e', o], REPO).code).length; }
    console.log(`✓ old objects with secrets deleted${packed ? ` · ${packed} could not be removed from the pack` : ''}`);
  }
  // Entire's local copies and this repo's Claude Code transcripts.
  const roots = [path.join(GIT_DIR, 'entire-sessions'), ...worktrees().flatMap((d) => ['metadata', 'logs', 'tmp'].map((x) => path.join(d, '.entire', x)))];
  const home = path.join(os.homedir(), '.claude', 'projects');
  const prefix = REPO.replace(/[^a-zA-Z0-9]/g, '-');
  if (fs.existsSync(home)) roots.push(...fs.readdirSync(home).filter((d) => d === prefix || d.startsWith(prefix + '-')).map((d) => path.join(home, d)));
  let masked = 0, inFiles = 0;
  const walk = (d) => { let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) { const n = maskInPlace(p, rx); if (n) { masked += n; inFiles++; } } } };
  roots.filter((r) => fs.existsSync(r)).forEach(walk);
  console.log(`✓ ${masked} secrets masked in ${inFiles} local files (Entire state, Claude Code transcripts)${rewritten ? '' : ''}`);
  const left = secretCheck(checkpoints());
  console.log(left.length ? `⚠ still found in: ${left.map((b) => b.id).join(', ')}` : '✓ no known secrets left in any checkpoint');
}
function checkpoints() {
  const local = gitc(['for-each-ref', '--format=%(objectname) %(refname)', 'refs/entire/checkpoints'], REPO).out.split('\n').filter(Boolean).map((l) => { const [obj, ref] = l.split(' '); return { obj, ref, id: ref.split('/').pop() }; });
  const remote = new Map(gitc(['ls-remote', 'origin'], REPO).out.split('\n').filter((l) => l.includes('\trefs/entire/checkpoints/')).map((l) => { const [obj, ref] = l.split('\t'); return [ref, obj]; }));
  return local.map((c) => ({ ...c, pushed: remote.get(c.ref) === c.obj }));
}
async function status() {
  console.log(fs.existsSync(EXE) ? `✓ ${entire(['version']).out.split('\n')[0]} in ${path.relative(REPO, BIN_DIR)}/` : '✗ Entire not installed in this repo (npm run entire -- install)');
  for (const dir of worktrees()) {
    const lf = path.join(dir, '.claude', 'settings.local.json');
    const on = fs.existsSync(path.join(dir, '.entire', 'settings.local.json')) && fs.existsSync(lf) && fs.readFileSync(lf, 'utf8').includes(BIN_DIR);
    console.log(`  ${on ? '✓' : '·'} ${path.relative(REPO, dir) || '(main checkout)'}${on ? '' : ' (capture off)'}`);
  }
  const cps = checkpoints();
  console.log(`${cps.length} checkpoints · ${cps.filter((c) => !c.pushed).length} only on this computer`);
  const bad = secretCheck(cps);
  for (const b of bad) console.log(`⚠ checkpoint ${b.id}${cps.find((c) => c.id === b.id)?.pushed ? ' (ALREADY ON origin)' : ''}: ${b.files.join(', ')}`);
  if (!bad.length) console.log('✓ no known secrets in any checkpoint');
}
function push() {
  need();
  const todo = checkpoints().filter((c) => !c.pushed);
  if (!todo.length) return console.log('✓ nothing to upload');
  const bad = secretCheck(todo);
  if (bad.length) { for (const b of bad) console.log(`⚠ ${b.id}: ${b.files.join(', ')}`); die('Not uploading. Run `npm run entire -- scrub` first.'); }
  const r = entire(['checkpoint', 'push', '--all'], REPO);
  console.log(r.code ? `✗ ${r.err || r.out}` : `✓ ${todo.length} checkpoints uploaded to origin`);
}

const [cmd = 'setup', ...rest] = process.argv.slice(2);
const dry = rest.includes('--dry-run');
const steps = { install, enable, backfill: () => backfill({ dry }), status, push, scrub, setup: async () => { await install(); enable(); await backfill({ dry }); scrub(); } };
if (!steps[cmd]) die(`Unknown command "${cmd}". Use: install, enable, backfill [--dry-run], status, scrub, push.`);
await steps[cmd]();
