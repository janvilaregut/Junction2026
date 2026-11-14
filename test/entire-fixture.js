// A git repo with Entire checkpoints, for the session tests (not a test file itself).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

/** A repo with two commits made in one agent session, linked afterwards (no trailer), plus one hand-made commit. */
export function fixture({ fullTranscript = '{}\n' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'katse-sessions-'));
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'commit', '-q', '--allow-empty', '-m', 'base');
  g(dir, 'checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(dir, 'a.txt'), '1'); g(dir, 'add', '.'); g(dir, 'commit', '-q', '-m', 'Add a');
  const a = g(dir, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(dir, 'b.txt'), '1'); g(dir, 'add', '.'); g(dir, 'commit', '-q', '-m', 'Add b');
  const b = g(dir, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(dir, 'c.txt'), '1'); g(dir, 'add', '.'); g(dir, 'commit', '-q', '-m', 'Add c by hand');
  const c = g(dir, 'rev-parse', 'HEAD');

  const line = (o) => JSON.stringify({ v: 1, agent: 'claude-code', ts: '2026-11-14T10:00:00Z', ...o });
  const tool = (cmd, out) => ({ type: 'tool_use', name: 'Bash', id: 'x', input: { command: cmd, description: 'run' }, result: { output: out, status: 'success' } });
  const transcript = [
    line({ type: 'user', content: [{ text: 'Make file a' }] }),
    line({ type: 'assistant', content: [tool('git commit -qm "Add a" && git log --oneline -1', `${a.slice(0, 7)} Add a`)] }),
    line({ type: 'user', content: [{ text: '<system-reminder>ignore me</system-reminder>' }] }),
    line({ type: 'user', content: [{ text: 'Now file b please' }] }),
    line({ type: 'assistant', content: [{ type: 'text', text: 'Doing **b**.' }] }),
    line({ type: 'assistant', content: [tool('git add . && git commit -m "Add b"', `[feature ${b.slice(0, 7)}] Add b\n 1 file changed`)] }),
    line({ type: 'user', content: [{ text: 'thanks, and something else' }] }),
  ].join('\n') + '\n';
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'katse-cp-'));
  fs.mkdirSync(path.join(work, '0'));
  fs.writeFileSync(path.join(work, '0', 'transcript.jsonl'), transcript);
  fs.writeFileSync(path.join(work, '0', 'full.jsonl'), fullTranscript);
  fs.writeFileSync(path.join(work, '0', 'prompt.txt'), 'Make file a\n\n---\n\nNow file b please');
  fs.writeFileSync(path.join(work, '0', 'metadata.json'), JSON.stringify({ agent: 'Claude Code', model: 'claude-opus-5-5', session_id: 'abc12345-0000', created_at: '2026-11-14T10:05:00Z', session_metrics: { turn_count: 3 } }));
  const session = { metadata: '/0/metadata.json', transcript: '/0/full.jsonl', compact_transcript: '/0/transcript.jsonl', prompt: '/0/prompt.txt' };
  for (const [id, sha] of [['01AAAAAAAAAAAAAAAAAAAAAAAA', a], ['01BBBBBBBBBBBBBBBBBBBBBBBB', b]]) {
    fs.writeFileSync(path.join(work, 'metadata.json'), JSON.stringify({ checkpoint_id: id, sessions: [session], linked_commits: [{ sha }] }));
    const idx = path.join(work, '.idx');
    const env = { ...process.env, GIT_INDEX_FILE: idx, GIT_WORK_TREE: work };
    execFileSync('git', ['add', '-A', '.'], { cwd: dir, env: { ...env, GIT_DIR: path.join(dir, '.git') } });
    const tree = execFileSync('git', ['write-tree'], { cwd: dir, env: { ...env, GIT_DIR: path.join(dir, '.git') }, encoding: 'utf8' }).trim();
    const commit = g(dir, 'commit-tree', tree, '-m', `Checkpoint: ${id}`);
    g(dir, 'update-ref', `refs/entire/checkpoints/${id.slice(-2)}/${id}`, commit);
    fs.rmSync(idx, { force: true });
  }
  return { dir, a, b, c };
}

