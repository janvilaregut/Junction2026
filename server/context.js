// What a project is, what a change is for and what a function does, in words. No model and no numbers:
// the repository's own README, the requirement behind the branch and the function's own comment and code.
// The voice assistant explains with this, so it can say what things do instead of reciting measurements.
import { git, resolveRef, commits } from './git.js';
import { requirementOf } from './math/nodereview.js';

const show = async (repo, ref, file) => {
  const r = await git(repo, ['show', `${ref}:${file}`], { allowFail: true });
  return r.code === 0 ? r.stdout : null;
};
const clip = (s, n) => (s.length > n ? s.slice(0, n).replace(/\s+\S*$/, '') + '…' : s);

/** A README as plain prose: no badges, images, HTML, tables or code blocks; headings kept as lines. */
export function plainReadme(text, max = 1800) {
  const out = String(text || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .split('\n').map((l) => l.replace(/^#+\s*/, '').replace(/[*_`]/g, '').trim())
    .filter((l) => l && !/^[|\-=:\s]+$/.test(l) && !l.startsWith('|'))
    .join('\n');
  return clip(out, max);
}

/** The project: its README in plain words and what sits at its top level. */
export async function projectContext(project) {
  const repo = project.path, base = await resolveRef(repo, project.base).catch(() => 'HEAD');
  const top = (await git(repo, ['ls-tree', '--name-only', base], { allowFail: true })).stdout.split('\n').filter(Boolean);
  const name = top.find((f) => /^readme(\.(md|rst|txt))?$/i.test(f));
  const readme = name ? await show(repo, base, name) : null;
  return {
    name: project.name, source: project.origin || project.url || null, base: project.base,
    about: readme ? plainReadme(readme) : null,
    topLevel: top.filter((f) => !f.startsWith('.')).slice(0, 30),
    note: readme ? 'From the repository\'s own README.' : 'This repository has no README: say what it is from its folders and the change, and say that you are inferring.',
  };
}

/** The change: what it was asked to do (the issue, the recorded prompt or its commit messages) and where it touches. */
export async function changeContext(project, pr) {
  const repo = project.path;
  const req = await requirementOf(project, pr).catch(() => null);
  const base = await resolveRef(repo, project.base).catch(() => null);
  const list = base ? await commits(repo, base, pr.ref).catch(() => []) : [];
  const names = base ? (await git(repo, ['diff', '--name-only', `${base}...${pr.ref}`], { allowFail: true })).stdout.split('\n').filter(Boolean) : [];
  const dirs = new Map();
  for (const f of names) { const d = f.includes('/') ? f.split('/').slice(0, 2).join('/') : '(top level)'; dirs.set(d, (dirs.get(d) || 0) + 1); }
  return {
    branch: pr.branch, title: pr.title,
    askedFor: req?.text ? { from: req.label, text: clip(req.text, 2200), url: req.url || null } : null,
    commits: list.slice(-8).map((c) => c.subject),
    touches: [...dirs].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([dir, files]) => `${dir} (${files} ${files === 1 ? 'file' : 'files'})`),
    filesChanged: names.length,
    note: req?.source === 'commits' ? 'No issue or prompt is linked to this branch: what it was asked to do is read from its commit messages.' : undefined,
  };
}

const COMMENT = /^\s*(\/\/\/?|\/\*+|\*+\/?|#|"""|''')/;
/** One function: its own comment, its code as the branch leaves it, who calls it and what it calls. */
export async function spotContext(project, math, id) {
  const n = math.nodes.find((x) => x.id === id);
  if (!n) throw new Error('Unknown spot');
  const text = n.status === 'removed' ? null : await show(project.path, math.head, n.file);
  const lines = text ? text.split('\n') : [];
  let doc = [];
  for (let i = n.start - 2; i >= 0 && doc.length < 25 && (COMMENT.test(lines[i]) || /^\s*\[.*\]\s*$/.test(lines[i])); i--) doc.unshift(lines[i]);
  const comment = doc.filter((l) => COMMENT.test(l)).map((l) => l.replace(COMMENT, '').replace(/<[^>]+>/g, ' ').replace(/\*\/\s*$/, '').trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ');
  const other = (e) => math.nodes.find((x) => x.id === (e.from === id ? e.to : e.from));
  const self = n.qname || n.name; // a long function is drawn as several parts with one name: they are not its callers
  const names = (es) => [...new Set(es.map(other).filter(Boolean).map((o) => o.qname || o.name))].filter((x) => x !== self).slice(0, 12);
  const calls = math.edges.filter((e) => e.kind === 'calls');
  return {
    name: n.qname || n.name, file: n.file, kind: n.kind, change: { added: 'new in this change', removed: 'removed by this change', modified: 'modified by this change', affected: 'not changed, but something it uses changed', context: 'not changed' }[n.status] || n.status,
    itsOwnComment: comment ? clip(comment, 600) : null,
    code: lines.length ? clip(lines.slice(n.start - 1, Math.min(n.end, n.start + 69)).join('\n'), 3600) : null,
    codeCutShort: n.end - n.start + 1 > 70 || undefined,
    calledBy: names(calls.filter((e) => e.to === id)), calls: names(calls.filter((e) => e.from === id)),
    testedBy: names(math.edges.filter((e) => e.kind === 'tests' && e.to === id)),
    whyItMatters: n.impactWhy || null,
  };
}
