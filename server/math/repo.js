// Reads source straight from git objects: the tree of any ref and its blobs in one `cat-file --batch`.
// Nothing is checked out and the repository is never written to, so a branch can be analysed while the
// working tree is on another one.
import { spawn } from 'node:child_process';
import { toolEnv } from '../util.js';
import { langOf } from './lex.js';

const MAX_FILE = 400_000; // bytes; larger files are generated or data, not something a person reviews
const SKIP = /(^|\/)(node_modules|vendor|third_party|dist|build|out|bin|obj|target|\.git|\.venv|venv|__pycache__|Pods|\.next|coverage)\//;

/** Run git and return stdout as a Buffer (no size cap, unlike util.run). */
export function gitRaw(repo, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: repo, env: toolEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    const out = []; let err = '';
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`git ${args.join(' ')} failed: ${err.trim().slice(0, 300)}`))));
    child.stdin.on('error', () => {});
    child.stdin.end(input || '');
  });
}

/** Every blob of a ref: [{ path, sha, size }]. */
export async function listFiles(repo, ref) {
  const raw = (await gitRaw(repo, ['ls-tree', '-r', '-l', '-z', ref])).toString('utf8');
  const files = [];
  for (const rec of raw.split('\0')) {
    const tab = rec.indexOf('\t'); if (tab < 0) continue;
    const [mode, type, sha, size] = rec.slice(0, tab).split(/\s+/);
    if (type === 'blob' && mode !== '120000') files.push({ path: rec.slice(tab + 1), sha, size: Number(size) || 0 });
  }
  return files;
}

/** Contents of many blobs in one process. Returns Map<sha, string>; binary blobs (a NUL in the first 8 KB) are left out. */
export async function readBlobs(repo, shas) {
  const uniq = [...new Set(shas)], out = new Map();
  if (!uniq.length) return out;
  const buf = await gitRaw(repo, ['cat-file', '--batch'], uniq.join('\n') + '\n');
  let off = 0;
  for (const sha of uniq) {
    const nl = buf.indexOf(10, off); if (nl < 0) break;
    const head = buf.toString('utf8', off, nl).split(' ');
    if (head[1] === 'missing') { off = nl + 1; continue; }
    const size = Number(head[2]), body = buf.subarray(nl + 1, nl + 1 + size);
    if (!body.subarray(0, 8192).includes(0)) out.set(sha, body.toString('utf8'));
    off = nl + 1 + size + 1;
  }
  return out;
}

/**
 * The source files of a ref that the engine reads as code: [{ path, sha, text, lang }].
 * `only` restricts to a set of languages; `limit` bounds how many files are read (largest repositories).
 */
export async function loadSources(repo, ref, { only = null, limit = 8000, extra = [] } = {}) {
  const all = await listFiles(repo, ref);
  const want = new Set(extra);
  const picked = all.filter((f) => want.has(f.path) || (langOf(f.path) && (!only || only.has(langOf(f.path))) && f.size <= MAX_FILE && !SKIP.test(f.path)));
  const truncated = picked.length > limit;
  const use = truncated ? picked.slice(0, limit) : picked;
  const blobs = await readBlobs(repo, use.map((f) => f.sha));
  return { files: use.filter((f) => blobs.has(f.sha)).map((f) => ({ path: f.path, sha: f.sha, text: blobs.get(f.sha), lang: langOf(f.path) })), total: all.length, truncated, tree: all };
}

/** One file at a ref, or null when it does not exist there. */
export async function readFileAt(repo, ref, path) {
  try { return (await gitRaw(repo, ['show', `${ref}:${path}`])).toString('utf8'); } catch { return null; }
}
