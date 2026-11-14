// Project registry and pull-request discovery.
// A "pull request" here is a branch that is ahead of the project's base:
//   incoming = remote branches (someone pushed them for you to review)
//   outgoing = your local branches that are not pushed yet or are ahead of their upstream
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA, readJSON, writeJSON, slug, which, run } from './util.js';
import { clis } from './llm.js';
import { git, out, isRepo, defaultBase, originSlug, resolveRef } from './git.js';
import { requirementIdFrom } from './requirements.js';

const FILE = path.join(DATA, 'projects.json');

export function listProjects() {
  return readJSON(FILE, []);
}

export function getProject(id) {
  const p = listProjects().find((x) => x.id === id);
  if (!p) throw new Error(`Proyecto desconocido: ${id}`);
  return p;
}

export async function addProject(dir) {
  const abs = path.resolve(dir.replace(/^~(?=$|\/)/, os.homedir()));
  if (!fs.existsSync(abs)) throw new Error(`No existe la carpeta ${abs}`);
  const top = await isRepo(abs);
  if (!top) throw new Error(`${abs} no es un repositorio git`);
  const projects = listProjects();
  const existing = projects.find((p) => p.path === top);
  if (existing) return existing;
  const base = await defaultBase(top);
  const origin = await originSlug(top);
  const p = {
    id: slug(path.basename(top)) + '-' + Date.now().toString(36),
    name: path.basename(top),
    path: top,
    base,
    origin,
    issueRepo: null, // resolved lazily (fork → upstream) or set by the user
    commands: { build: '', test: '' },
    added: new Date().toISOString(),
  };
  projects.push(p);
  writeJSON(FILE, projects);
  return p;
}

export async function cloneProject(url, intoDir) {
  if (!/^https:\/\/[\w.-]+\/[\w./-]+$/.test(url)) throw new Error('URL no válida (usa https://…)');
  const name = slug(url.split('/').pop().replace(/\.git$/, ''));
  const dest = path.resolve(intoDir, name);
  if (!fs.existsSync(dest)) {
    const r = await run('git', ['clone', '--quiet', ...(process.platform === 'win32' ? ['-c', 'core.longpaths=true'] : []), url, dest], { timeout: 20 * 60_000 });
    if (r.code !== 0) throw new Error(`git clone falló: ${r.stderr.trim()}`);
  }
  return addProject(dest);
}

export function updateProject(id, patch) {
  const projects = listProjects();
  const p = projects.find((x) => x.id === id);
  if (!p) throw new Error(`Proyecto desconocido: ${id}`);
  for (const k of ['base', 'issueRepo', 'name']) if (typeof patch[k] === 'string') p[k] = patch[k].trim() || null;
  if (patch.commands) p.commands = { build: patch.commands.build || '', test: patch.commands.test || '' };
  writeJSON(FILE, projects);
  return p;
}

export function removeProject(id) {
  writeJSON(FILE, listProjects().filter((p) => p.id !== id));
}

async function branchInfo(repo, baseRef, ref) {
  const counts = await out(repo, ['rev-list', '--left-right', '--count', `${baseRef}...${ref}`]);
  const [behind, ahead] = counts.split(/\s+/).map(Number);
  return { ahead, behind };
}

/** Environment facts the UI shows next to the project. */
export async function projectStatus(p) {
  const have = await clis();
  const [entire, dotnet] = await Promise.all([
    which('entire'),
    which('dotnet'),
  ]);
  let entireEnabled = false;
  if (entire) {
    const r = await run('entire', ['status'], { cwd: p.path, timeout: 15_000 });
    entireEnabled = r.code === 0 && !/not enabled|disabled/i.test(r.stdout + r.stderr);
  }
  return {
    entire: { installed: !!entire, enabled: entireEnabled },
    agents: { claude: have.claude, claudeInstalled: have.claudeInstalled, opencode: have.opencode },
    toolchains: { dotnet: !!dotnet },
  };
}

export async function listPullRequests(p, { fetch = false } = {}) {
  const repo = p.path;
  if (fetch) await git(repo, ['fetch', '--quiet', '--prune', 'origin'], { allowFail: true, timeout: 180_000 });
  const baseRef = await resolveRef(repo, p.base);
  const fmt = '%(refname)%1f%(refname:short)%1f%(upstream:short)%1f%(committerdate:iso-strict)%1f%(subject)%1f%(objectname:short)';
  const raw = await out(repo, ['for-each-ref', `--format=${fmt}`, 'refs/heads', 'refs/remotes/origin']);
  const refs = raw.split('\n').filter(Boolean).map((l) => {
    const [full, short, upstream, date, subject, sha] = l.split('\x1f');
    return { full, short, upstream, date, subject, sha };
  });
  const baseNames = new Set([p.base, `origin/${p.base}`, 'origin/HEAD', 'origin']);
  const incoming = [];
  const outgoing = [];
  const localUpstreams = new Map(refs.filter((r) => r.full.startsWith('refs/heads/')).map((r) => [r.upstream, r]));

  for (const r of refs) {
    if (baseNames.has(r.short)) continue;
    const isRemote = r.full.startsWith('refs/remotes/');
    const info = await branchInfo(repo, baseRef, r.full);
    if (info.ahead === 0 || info.ahead > 50) continue; // nothing to review, or an unrelated long-lived line
    const name = isRemote ? r.short.replace(/^origin\//, '') : r.short;
    const item = {
      id: (isRemote ? 'in:' : 'out:') + name,
      direction: isRemote ? 'incoming' : 'outgoing',
      branch: name,
      ref: r.full,
      sha: r.sha,
      title: r.subject,
      date: r.date,
      ahead: info.ahead,
      behind: info.behind,
      requirement: requirementIdFrom(`${name} ${r.subject}`),
    };
    if (isRemote) {
      incoming.push(item);
    } else {
      // A local branch identical to its upstream is just a checkout of an incoming PR, not something you send.
      if (r.upstream) {
        const up = await branchInfo(repo, r.upstream, r.full).catch(() => ({ ahead: 1 }));
        if (up.ahead === 0) continue;
      }
      outgoing.push(item);
    }
  }
  void localUpstreams;
  const byDate = (a, b) => (b.date || '').localeCompare(a.date || '');
  return { base: p.base, incoming: incoming.sort(byDate).slice(0, 30), outgoing: outgoing.sort(byDate).slice(0, 30) };
}

export async function findPullRequest(p, prId) {
  const all = await listPullRequests(p);
  const pr = [...all.incoming, ...all.outgoing].find((x) => x.id === prId);
  if (!pr) throw new Error(`No encuentro el PR ${prId}`);
  return pr;
}
