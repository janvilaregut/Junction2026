// Throw-away working copies. The user's repository is never modified: every build, test and agent runs
// in a tree created here and removed when the run ends.
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../util.js';
import { git } from '../git.js';

const ID = ['-c', 'user.name=replica', '-c', 'user.email=replica@localhost', '-c', 'commit.gpgsign=false'];

/** A detached git worktree at `ref`. Shares objects with the repo, so it is fast to create. */
export async function worktree(repo, dir, ref) {
  fs.rmSync(dir, { recursive: true, force: true });
  await git(repo, ['worktree', 'prune'], { allowFail: true });
  await git(repo, ['worktree', 'add', '--detach', '--force', dir, ref], { timeout: 180_000 });
  return dir;
}

export async function removeWorktree(repo, dir) {
  await git(repo, ['worktree', 'remove', '--force', dir], { allowFail: true });
  fs.rmSync(dir, { recursive: true, force: true });
  await git(repo, ['worktree', 'prune'], { allowFail: true });
}

/**
 * The tree you would get by merging the PR into its target. Returns { ok, conflicts }.
 * The merge commit lives only in the worktree's detached HEAD.
 */
export async function mergedTree(repo, dir, baseRef, headSha) {
  await worktree(repo, dir, baseRef);
  const r = await git(dir, [...ID, 'merge', '--no-ff', '--no-edit', headSha], { allowFail: true, timeout: 180_000 });
  if (r.code === 0) return { ok: true, conflicts: [] };
  const c = await git(dir, ['diff', '--name-only', '--diff-filter=U'], { allowFail: true });
  await git(dir, ['merge', '--abort'], { allowFail: true });
  return { ok: false, conflicts: c.stdout.split('\n').filter(Boolean), log: (r.stdout + r.stderr).trim() };
}

/** Overlay specific paths from another commit onto a tree (used to bring the PR's tests onto the base). */
export async function overlay(dir, sha, paths) {
  if (!paths.length) return;
  for (let i = 0; i < paths.length; i += 100) {
    await git(dir, ['checkout', sha, '--', ...paths.slice(i, i + 100)], { timeout: 120_000 });
  }
}

export async function resetTree(dir) {
  await git(dir, ['reset', '--hard', '--quiet'], { allowFail: true });
  await git(dir, ['clean', '-fdq', '-e', 'bin', '-e', 'obj', '-e', 'node_modules'], { allowFail: true });
}

/**
 * A blind copy for a replica agent: the files of one commit with a fresh one-commit history.
 * It carries no branches and no log, so the agent cannot look at the PR it is re-deriving.
 */
export async function blindCopy(repo, dir, sha) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const archive = `${dir}.tar`;
  try {
    await git(repo, ['archive', '--format=tar', '--output', archive, sha], { timeout: 300_000 });
    const extracted = await run('tar', ['-xf', archive, '-C', dir], { timeout: 300_000 });
    if (extracted.code !== 0) throw new Error(`No se pudo crear la copia aislada: ${extracted.stderr.trim()}`);
  } finally {
    fs.rmSync(archive, { force: true });
  }
  await git(dir, ['init', '--quiet']);
  if (process.platform === 'win32') await git(dir, ['config', 'core.longpaths', 'true']);
  await git(dir, ['add', '-A'], { timeout: 180_000 });
  await git(dir, [...ID, 'commit', '--quiet', '--no-verify', '-m', 'base'], { timeout: 180_000 });
  return dir;
}

/** Everything the agent changed in a blind copy, as a patch against its base commit. */
export async function copyPatch(dir) {
  await git(dir, ['add', '-A'], { timeout: 120_000 });
  const r = await git(dir, ['diff', '--cached', '-U0', '--no-color', '--no-ext-diff', 'HEAD'], { timeout: 120_000 });
  return r.stdout;
}

export function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}
