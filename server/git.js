// Git access and unified-diff parsing.
import { run } from './util.js';

export async function git(repo, args, opts = {}) {
  const r = await run('git', args, { cwd: repo, timeout: opts.timeout || 120_000, ...opts });
  if (r.code !== 0 && !opts.allowFail) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim() || r.stdout.trim()}`);
  }
  return r;
}

export const out = async (repo, args, opts) => (await git(repo, args, opts)).stdout.trim();

export async function isRepo(dir) {
  const r = await run('git', ['rev-parse', '--show-toplevel'], { cwd: dir, timeout: 10_000 });
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function defaultBase(repo) {
  const head = await git(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { allowFail: true });
  if (head.code === 0 && head.stdout.trim()) return head.stdout.trim().replace(/^origin\//, '');
  for (const b of ['main', 'master', 'develop']) {
    const r = await git(repo, ['rev-parse', '--verify', '--quiet', b], { allowFail: true });
    if (r.code === 0) return b;
  }
  return out(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

/** Resolve a base name to a ref that exists locally (prefers origin/<base> when the local one is missing). */
export async function resolveRef(repo, name) {
  for (const cand of [name, `origin/${name}`]) {
    const r = await git(repo, ['rev-parse', '--verify', '--quiet', `${cand}^{commit}`], { allowFail: true });
    if (r.code === 0) return cand;
  }
  throw new Error(`No existe la rama ${name}`);
}

export async function originSlug(repo) {
  const r = await git(repo, ['remote', 'get-url', 'origin'], { allowFail: true });
  const m = r.stdout.trim().match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/);
  return m ? m[1] : null;
}

/** Commits in base..head with full messages, oldest first. */
export async function commits(repo, base, head) {
  const raw = await out(repo, ['log', '--reverse', '--format=%H%x1f%an%x1f%aI%x1f%s%x1f%B%x1e', `${base}..${head}`]);
  return raw.split('\x1e').map((s) => s.trim()).filter(Boolean).map((s) => {
    const [sha, author, date, subject, body] = s.split('\x1f');
    return { sha, author, date, subject, body: (body || '').trim() };
  });
}

/**
 * Parse `git diff -U0` output into files with hunks.
 * Each hunk keeps old/new ranges plus the removed and added lines.
 */
export function parseDiff(text) {
  const files = [];
  let f = null;
  let h = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git a\/(.*) b\/(.*)$/);
      f = { path: m ? m[2] : line, oldPath: m ? m[1] : null, status: 'modified', binary: false, hunks: [] };
      files.push(f);
      h = null;
      continue;
    }
    if (!f) continue;
    if (line.startsWith('new file mode')) { f.status = 'added'; continue; }
    if (line.startsWith('deleted file mode')) { f.status = 'deleted'; continue; }
    if (line.startsWith('rename to ')) { f.status = 'renamed'; continue; }
    if (line.startsWith('Binary files')) { f.binary = true; continue; }
    // File headers only come before the first hunk; inside a hunk `--- x` is the removed line `-- x` (SQL/Lua comments).
    if (!h && (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('index '))) continue;
    const hm = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hm) {
      h = {
        oldStart: +hm[1], oldLines: hm[2] === undefined ? 1 : +hm[2],
        newStart: +hm[3], newLines: hm[4] === undefined ? 1 : +hm[4],
        removed: [], added: [],
      };
      f.hunks.push(h);
      continue;
    }
    if (!h) continue;
    if (line.startsWith('+')) h.added.push(line.slice(1));
    else if (line.startsWith('-')) h.removed.push(line.slice(1));
  }
  for (const file of files) {
    file.add = file.hunks.reduce((n, x) => n + x.added.length, 0);
    file.del = file.hunks.reduce((n, x) => n + x.removed.length, 0);
  }
  return files;
}

export async function diff(repo, from, to, paths = []) {
  // core.quotePath=false: paths with non-ASCII characters come out as they are, not as quoted octal escapes that match nothing.
  // The a/ and b/ prefixes are spelled out: a user's diff.noprefix or diff.mnemonicPrefix would otherwise produce headers parseDiff does not read.
  const r = await git(repo, ['-c', 'core.quotePath=false', 'diff', '-U0', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', '-M', from, ...(to ? [to] : []), '--', ...paths], { timeout: 180_000 });
  return parseDiff(r.stdout);
}
