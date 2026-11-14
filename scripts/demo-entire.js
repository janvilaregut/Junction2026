#!/usr/bin/env node
// Seeds Entire checkpoints in the demo repository (workspace/messagepack-csharp) so every commit of its demo
// history (demo/main) and of the demo branches (easy/*, mine/*) shows which agent made it.
// These are FIXTURES, not recorded sessions: each one says so ("seeded": true, and in its transcript). They use
// Entire's on-disk format (refs/entire/checkpoints/<xx>/<id>, linked by linked_commits: history is not rewritten)
// and only agents Entire supports. Local only: nothing is pushed. Run again after the branches change.
//   node scripts/demo-entire.js          seed what is missing
//   node scripts/demo-entire.js --clean  remove every seeded checkpoint
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.join(ROOT, 'workspace', 'messagepack-csharp');
const UPSTREAM = 'dependabot/nuget/develop/PolySharp-1.15.0', BASE = 'demo/main';
const g = (args, env) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8', env: { ...process.env, ...env } }).trim();

// Agents Entire supports (entire enable --agent …) that Katse has a mark for.
const AGENTS = {
  claude: { agent: 'Claude Code', slug: 'claude-code', model: 'claude-opus-5-5' },
  codex: { agent: 'Codex', slug: 'codex' },
  antigravity: { agent: 'Antigravity', slug: 'antigravity' },
  cursor: { agent: 'Cursor', slug: 'cursor' },
  opencode: { agent: 'OpenCode', slug: 'opencode' },
  copilot: { agent: 'Copilot CLI', slug: 'copilot-cli' },
};
const HISTORY = ['claude', 'codex', 'antigravity', 'cursor', 'opencode', 'copilot', 'claude', 'codex', 'cursor', 'antigravity'];
const BRANCHES = [['claude'], ['codex', 'claude'], ['antigravity', 'cursor'], ['opencode', 'claude'], ['copilot']]; // in branch-name order; mine/* is always Claude Code

const idOf = (sha) => '01' + crypto.createHash('sha256').update('katse-demo:' + sha).digest('hex').slice(0, 24).toUpperCase();
const refOf = (id) => `refs/entire/checkpoints/${id.slice(-2)}/${id}`;
const seededRefs = () => g(['for-each-ref', '--format=%(refname)', 'refs/entire/checkpoints']).split('\n').filter(Boolean)
  .filter((r) => { try { return JSON.parse(g(['cat-file', '-p', `${r}:metadata.json`])).seeded === true; } catch { return false; } });

if (process.argv.includes('--clean')) {
  const refs = seededRefs();
  for (const r of refs) g(['update-ref', '-d', r]);
  console.log(`removed ${refs.length} seeded checkpoints`);
  process.exit(0);
}

const commitsOf = (range) => g(['log', '--first-parent', '--reverse', '--format=%H%x1f%s%x1f%aI', range]).split('\n').filter(Boolean)
  .map((l) => { const [sha, subject, date] = l.split('\x1f'); return { sha, subject, date }; });
const jobs = [];
commitsOf(`${UPSTREAM}..${BASE}`).forEach((c, i) => jobs.push({ ...c, branch: BASE, agents: [HISTORY[i % HISTORY.length]] }));
const branches = g(['for-each-ref', '--format=%(refname:short)', 'refs/heads/easy', 'refs/heads/mine']).split('\n').filter(Boolean).sort();
let k = 0;
for (const b of branches) for (const c of commitsOf(`${BASE}..${b}`)) jobs.push({ ...c, branch: b, agents: b.startsWith('mine/') ? ['claude'] : BRANCHES[k++ % BRANCHES.length] });

const wanted = new Set(jobs.map((j) => refOf(idOf(j.sha))));
for (const r of seededRefs()) if (!wanted.has(r)) g(['update-ref', '-d', r]); // a branch that moved: its old checkpoint goes

let made = 0;
for (const j of jobs) {
  const id = idOf(j.sha), ref = refOf(id);
  try { g(['rev-parse', '--verify', '--quiet', ref]); continue; } catch { /* missing: seed it */ }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'katse-seed-'));
  const files = g(['show', '--name-only', '--format=', j.sha]).split('\n').filter(Boolean);
  const sessions = j.agents.map((key, i) => {
    const a = AGENTS[key], dir = path.join(work, String(i));
    fs.mkdirSync(dir);
    const first = i === 0;
    const prompt = first ? `${j.subject}. Keep the change small and commit it.` : `Review that change against what was asked before it is committed: ${j.subject.toLowerCase()}.`;
    const ts = new Date(Date.parse(j.date) - (first ? 240 : 90) * 1000).toISOString();
    const line = (o) => JSON.stringify({ v: 1, agent: a.slug, ts, ...o });
    const lines = [
      line({ type: 'user', content: [{ text: prompt }] }),
      line({ type: 'assistant', content: [{ type: 'text', text: `Seeded demo session (a fixture, not a recorded conversation).\n\n${first ? `Edited ${files.slice(0, 3).map((f) => '`' + f + '`').join(', ')}.` : 'Read the diff against the request; nothing to add.'}` }] }),
      line({ type: 'assistant', content: [{ type: 'tool_use', name: 'Bash', id: `seed-${i}`, input: { command: `git commit -am ${JSON.stringify(j.subject)}`, description: 'Commit the change' }, result: { output: `[${j.branch} ${j.sha.slice(0, 7)}] ${j.subject}\n ${files.length} file${files.length === 1 ? '' : 's'} changed`, status: 'success' } }] }),
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(dir, 'transcript.jsonl'), lines);
    fs.writeFileSync(path.join(dir, 'full.jsonl'), lines);
    fs.writeFileSync(path.join(dir, 'prompt.txt'), prompt);
    fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({ seeded: true, agent: a.agent, ...(a.model ? { model: a.model } : {}), session_id: `seed-${id.slice(2, 10).toLowerCase()}-${i}`, created_at: j.date, branch: j.branch, session_metrics: { turn_count: 1 } }, null, 2));
    return { metadata: `/${i}/metadata.json`, transcript: `/${i}/full.jsonl`, compact_transcript: `/${i}/transcript.jsonl`, prompt: `/${i}/prompt.txt` };
  });
  fs.writeFileSync(path.join(work, 'metadata.json'), JSON.stringify({ seeded: true, checkpoint_id: id, sessions, linked_commits: [{ sha: j.sha }], files_touched: files }, null, 2));
  const env = { GIT_DIR: g(['rev-parse', '--absolute-git-dir']), GIT_WORK_TREE: work, GIT_INDEX_FILE: path.join(os.tmpdir(), `katse-seed-${id}.idx`) };
  g(['add', '-A', '.'], env);
  const tree = g(['write-tree'], env);
  const stamp = { GIT_AUTHOR_NAME: 'Katse demo', GIT_AUTHOR_EMAIL: 'demo@katse.local', GIT_COMMITTER_NAME: 'Katse demo', GIT_COMMITTER_EMAIL: 'demo@katse.local', GIT_AUTHOR_DATE: j.date, GIT_COMMITTER_DATE: j.date };
  g(['update-ref', ref, g(['commit-tree', tree, '-m', `Checkpoint: ${id} (seeded demo fixture)`], stamp)]);
  fs.rmSync(env.GIT_INDEX_FILE, { force: true }); fs.rmSync(work, { recursive: true, force: true });
  made++;
  console.log(`${j.branch.padEnd(22)} ${j.sha.slice(0, 8)}  ${j.agents.map((x) => AGENTS[x].agent).join(' + ')}`);
}
console.log(`${made} seeded, ${jobs.length - made} already there`);
