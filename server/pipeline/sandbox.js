// Throw-away working copies. The user's repository is never modified: every build, test and agent runs
// in a tree created here and removed when the run ends.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { run, DATA } from '../util.js';
import { git } from '../git.js';

const ID = ['-c', 'user.name=replica', '-c', 'user.email=replica@localhost', '-c', 'commit.gpgsign=false'];

export function assertScratch(repo, dir) {
  const target = path.resolve(dir);
  const roots = [path.join(DATA, 'runs'), path.join(os.tmpdir(), 'katse')];
  const inside = (root, value) => { const r = path.relative(path.resolve(root), value); return r !== '' && !r.startsWith('..') && !path.isAbsolute(r); };
  const testRoot = path.relative(os.tmpdir(), target).split(path.sep)[0];
  if (/^katse-test-[a-zA-Z0-9]+$/.test(testRoot)) roots.push(path.join(os.tmpdir(), testRoot));
  if (!roots.some(root => inside(root, target))) throw new Error('Refusing to remove a directory outside Katse scratch roots');
  if (target === path.resolve(repo) || inside(target, path.resolve(repo))) throw new Error('Scratch directory contains the source repository');
  let existing = target;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  const resolved = fs.realpathSync(existing);
  // Roots resolved too: on macOS the temp dir lives behind a symlink (/var → /private/var).
  const real = (root) => { let r = path.resolve(root); const tail = []; while (!fs.existsSync(r)) { tail.unshift(path.basename(r)); r = path.dirname(r); } return path.join(fs.realpathSync(r), ...tail); };
  if (!roots.flatMap(root => [path.resolve(root), real(root)]).some(root => resolved === root || inside(root, resolved))) throw new Error('Scratch directory resolves outside its permitted root');
  return target;
}

/** A detached git worktree at `ref`. Shares objects with the repo, so it is fast to create. */
export async function worktree(repo, dir, ref) {
  assertScratch(repo, dir);
  fs.rmSync(dir, { recursive: true, force: true });
  await git(repo, ['worktree', 'prune'], { allowFail: true });
  await git(repo, ['worktree', 'add', '--detach', '--force', dir, ref], { timeout: 180_000 });
  return dir;
}

export async function removeWorktree(repo, dir) {
  assertScratch(repo, dir);
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
  assertScratch(repo, dir);
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
  // A tracked source file may match .gitignore (the Tieto fixture does this).
  // Preserve it in the fresh history, and preserve executable bits lost by Windows tar.
  await git(dir, ['add', '-f', '-A'], { timeout: 180_000 });
  const entries = (await git(repo, ['ls-tree', '-r', sha])).stdout.split('\n');
  const executable = entries.filter(l => l.startsWith('100755 ')).map(l => l.split('\t')[1]).filter(Boolean);
  for (let i = 0; i < executable.length; i += 50) await git(dir, ['update-index', '--chmod=+x', '--', ...executable.slice(i, i + 50)]);
  const expected = (await git(repo, ['rev-parse', `${sha}^{tree}`])).stdout.trim();
  const actual = (await git(dir, ['write-tree'])).stdout.trim();
  if (expected !== actual) throw new Error('Blind copy differs from source tree (archive attributes or unsupported file modes).');
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
