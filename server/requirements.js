// Requirement (issue) lookup and provenance (the prompt behind each commit, via Entire).
import path from 'node:path';
import { DATA, readJSON, writeJSON, run, which } from './util.js';
import { git } from './git.js';

export const PROMPT_NOTES = 'katse-prompt';

const CACHE = path.join(DATA, 'cache', 'issues.json');

export function requirementIdFrom(text) {
  const m = String(text).match(/(?:#|issue[-_ ]?)(\d{2,7})\b/i);
  return m ? m[1] : null;
}

async function gh(pathname) {
  const res = await fetch(`https://api.github.com${pathname}`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'katse-review' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} en ${pathname}`);
  return res.json();
}

/** The repo that owns the issues: explicit setting, else the fork's source, else origin. */
export async function issueRepoFor(project) {
  if (project.issueRepo) return project.issueRepo;
  if (!project.origin) return null;
  const cache = readJSON(CACHE, {});
  const key = `repo:${project.origin}`;
  if (cache[key] !== undefined) return cache[key];
  let repo = project.origin;
  try {
    const info = await gh(`/repos/${project.origin}`);
    repo = info.source?.full_name || info.parent?.full_name || project.origin;
    // A copy that is not a GitHub fork has no issues of its own; fall back to issue search by number later.
    if (!info.fork && !info.has_issues) repo = project.origin;
  } catch { /* offline: keep origin */ }
  cache[key] = repo;
  writeJSON(CACHE, cache);
  return repo;
}

export async function fetchRequirement(project, id) {
  if (!id) return null;
  const candidates = [];
  const primary = await issueRepoFor(project);
  if (primary) candidates.push(primary);
  // The challenge repo is a plain copy of MessagePack-CSharp: try the upstream it names in its README too.
  if (project.origin && /messagepack/i.test(project.origin)) candidates.push('MessagePack-CSharp/MessagePack-CSharp');
  const cache = readJSON(CACHE, {});
  for (const repo of [...new Set(candidates)]) {
    const key = `${repo}#${id}`;
    if (cache[key]) return cache[key];
    try {
      const d = await gh(`/repos/${repo}/issues/${id}`);
      const req = {
        id: `${repo}#${id}`, number: Number(id), repo, url: d.html_url,
        title: d.title, body: d.body || '', labels: (d.labels || []).map((l) => l.name), state: d.state,
      };
      cache[key] = req;
      writeJSON(CACHE, cache);
      return req;
    } catch { /* try next */ }
  }
  return { id: `#${id}`, number: Number(id), repo: primary, url: null, title: null, body: '', labels: [], missing: true };
}

/**
 * Provenance: Entire links a checkpoint to a commit with the trailer `Entire-Checkpoint: <id>`.
 * When the CLI is installed we read the checkpoint (prompt, transcript, files) with `entire checkpoint explain`.
 */
export async function provenance(repo, commitList) {
  const entire = await which('entire');
  const found = [];
  for (const c of commitList) {
    const m = c.body.match(/^Entire-Checkpoint:\s*(\S+)/m);
    if (!m) continue;
    const item = { commit: c.sha.slice(0, 9), checkpoint: m[1], prompt: null, source: 'trailer' };
    if (entire) {
      const r = await run('entire', ['checkpoint', 'explain', m[1]], { cwd: repo, timeout: 60_000 });
      if (r.code === 0) { item.prompt = r.stdout.trim().slice(0, 20_000); item.source = 'entire checkpoint explain'; }
      else item.error = (r.stderr || r.stdout).trim().slice(0, 500);
    }
    found.push(item);
  }
  const promptTrailers = commitList
    .map((c) => c.body.match(/^Agent-Prompt:\s*([\s\S]+?)(?:\n\S+:|$)/m))
    .filter(Boolean)
    .map((m) => m[1].trim());
  // Without Entire, a prompt can still travel with the commit as a git note (refs/notes/katse-prompt).
  const notes = [];
  for (const c of commitList) {
    const r = await git(repo, ['notes', `--ref=${PROMPT_NOTES}`, 'show', c.sha], { allowFail: true });
    if (r.code === 0 && r.stdout.trim()) notes.push({ commit: c.sha.slice(0, 9), prompt: r.stdout.trim().slice(0, 20_000) });
  }
  const fromEntire = found.find((x) => x.prompt)?.prompt;
  return {
    entireInstalled: !!entire,
    checkpoints: found,
    notes: notes.map((n) => n.commit),
    prompt: fromEntire || notes[0]?.prompt || promptTrailers[0] || null,
    status: fromEntire ? 'prompt' : notes.length ? 'nota' : found.length ? 'checkpoint-unread' : promptTrailers.length ? 'trailer' : 'none',
  };
}

/** Store the prompt behind a commit as a git note. Only called on an explicit user action. */
export async function savePrompt(repo, sha, prompt) {
  const text = String(prompt || '').trim();
  if (text.length < 10) throw new Error('El prompt está vacío o es demasiado corto.');
  await git(repo, ['notes', `--ref=${PROMPT_NOTES}`, 'add', '-f', '-m', text.slice(0, 20_000), sha]);
  return { ref: `refs/notes/${PROMPT_NOTES}`, commit: sha, push: `git push origin refs/notes/${PROMPT_NOTES}` };
}
