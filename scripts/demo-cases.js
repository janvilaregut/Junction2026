// The demo repository (workspace/messagepack-csharp): its own base branch and the four demo pull requests.
// Each pull request edits existing, long, well-connected functions: its graph shows the callers around them and
// the code panel has several chunks to colour.
//   demo/main            the base: eight small commits of our own on top of upstream
//   easy/empty-fastpath  one long function, correct                  → the agents reproduce it (starts green)
//   easy/lz4-guards      two functions, one with a > that must be >= → reproduced + differs (one-line fix);
//                        it starts un-reviewed: the agents are launched on it live
//   easy/collection-cap  two functions, both wrong                   → differs + differs: the one the agents block (starts red)
//   mine/skip-pool-rent  one function, correct, the user's own       → the agents reproduce it; it starts un-reviewed too
//
//   node scripts/demo-cases.js                 recreate demo/main and the branches from the patches if they are
//                                              missing, then seed the Entire checkpoints (scripts/demo-entire.js)
//   node scripts/demo-cases.js --reset         the state the demo starts in: the nodes carry the agents' result,
//                                              rebuilt from the cached reviews, except on the two live branches,
//                                              whose marks are cleared (its cached reviews stay: reviewing is instant)
//   node scripts/demo-cases.js --reset --blank forget the marks of the four heads instead (nodes un-reviewed;
//                                              the cached reviews stay, so reviewing again is instant)
// The patches are applied with the author's identity and date as committer, so the commits get the same
// sha as when the reviews were cached.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.KATSE_DATA || path.join(ROOT, 'data');
const REPO = path.join(ROOT, 'workspace', 'messagepack-csharp');
const PROJECT = 'messagepack-csharp-mwfmr6wg';
const UPSTREAM = 'dependabot/nuget/develop/PolySharp-1.15.0', BASE = 'demo/main';
const CASES = [
  { branch: BASE, patch: 'base.patch', from: UPSTREAM, base: true },
  { branch: 'easy/empty-fastpath', patch: 'accept.patch' },
  { branch: 'easy/lz4-guards', patch: 'needs-changes.patch', live: true },
  { branch: 'easy/collection-cap', patch: 'blocked.patch' },
  { branch: 'mine/skip-pool-rent', patch: 'mine.patch', live: true },
];

const git = (args, opts = {}) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
const headOf = (branch) => { try { return git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]); } catch { return null; } };

function create({ branch, patch, from: start = BASE }) {
  const file = path.join(ROOT, 'scripts', 'demo-cases', patch), text = fs.readFileSync(file, 'utf8');
  const expected = [...text.matchAll(/^From ([0-9a-f]{40}) /gm)].pop()?.[1], from = /^From: (.*) <(.*)>$/m.exec(text);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'katse-demo-'));
  const env = { ...process.env, ...(from ? { GIT_COMMITTER_NAME: from[1], GIT_COMMITTER_EMAIL: from[2] } : {}) };
  git(['worktree', 'add', '-q', '-b', branch, dir, start]);
  try { git(['-c', 'commit.gpgsign=false', 'am', '-q', '--committer-date-is-author-date', file], { cwd: dir, env }); }
  finally { git(['worktree', 'remove', '--force', dir]); fs.rmSync(dir, { recursive: true, force: true }); }
  const head = headOf(branch);
  console.log(`${branch}: created at ${head.slice(0, 8)}${expected && head !== expected ? ` (not the recorded ${expected.slice(0, 8)}: the commits after it get other shas, and the reviews will run again instead of coming from the cache)` : ''}`);
}

/** The marks of a head as the agents left them: one per cached review, in the shape reviewNode writes with setMark. */
function prepared(head) {
  const dir = path.join(DATA, 'math', PROJECT), prefix = `review-${head.slice(0, 12)}-`, marks = {};
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.json')).sort() : [];
  for (const f of files) {
    let r; try { r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (!r?.id || !r.verdict) continue;
    marks[r.id] = { state: r.verdict, by: 'agents', ms: r.ms, note: String(r.explanation || '').slice(0, 260) };
  }
  return marks;
}

const reset = process.argv.includes('--reset'), blank = process.argv.includes('--blank');
for (const c of CASES) {
  let head = headOf(c.branch);
  if (!head && !reset) { create(c); continue; }
  if (c.base) { if (!reset) console.log(`${c.branch}: already there at ${head.slice(0, 8)}`); continue; }
  if (!head) { console.log(`${c.branch}: missing (run without --reset to create it)`); continue; }
  if (!reset) { console.log(`${c.branch}: already there at ${head.slice(0, 8)}`); continue; }
  const file = path.join(DATA, 'math', PROJECT, `marks-${head.slice(0, 20)}.json`);
  if (blank || c.live) {
    const had = fs.existsSync(file);
    fs.rmSync(file, { force: true });
    console.log(`${c.branch}: ${had ? 'marks cleared' : 'no marks to clear'} (${head.slice(0, 8)})${blank ? '' : ': un-reviewed, the agents are launched on it live'}`);
    continue;
  }
  const marks = prepared(head), ids = Object.keys(marks);
  if (!ids.length) {
    fs.rmSync(file, { force: true });
    console.log(`${c.branch}: no cached reviews for ${head.slice(0, 8)}, so nothing to prepare: run its reviews once in the app, then --reset again`);
    continue;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(marks, null, 2));
  console.log(`${c.branch}: prepared (${head.slice(0, 8)}) ${ids.map((id) => `${id.split('.').pop()} ${marks[id].state}`).join(', ')}`);
}
// The agent sessions behind the commits (seeded fixtures): idempotent, and it follows the branch heads.
if (!reset) execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'demo-entire.js')], { stdio: 'inherit' });
