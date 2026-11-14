// Level 1: classify every changed file and detect mechanical (repeated) edits and their anomalies.
import path from 'node:path';

const DOC = /\.(md|rst|txt|adoc)$/i;
const CONFIG = /(\.(csproj|props|targets|sln|json|ya?ml|toml|ini|editorconfig|gitignore|config)$)|(^|\/)(Dockerfile|Makefile)$/i;
const LOCK = /(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|packages\.lock\.json|Cargo\.lock|poetry\.lock)$/i;
const GENERATED = /(\.g\.cs|\.g\.i\.cs|\.Designer\.cs|\.generated\.\w+|\.min\.js)$/i;
const SNAPSHOT = /(__snapshots__\/|\.snap$|\.verified\.\w+$|\.approved\.\w+$)/i;
const TEST = /(^|\/)(tests?|spec|__tests__)\/|(Tests?|Spec)\.(cs|ts|js|py|go|java)$|\.(test|spec)\.\w+$|_test\.\w+$/i;

/**
 * Category of one file. `allPaths` lets us spot template outputs (X.cs next to X.tt).
 * Returns { kind, reason } with kind in source|test|doc|config|derived.
 */
export function classifyFile(p, allPaths) {
  if (LOCK.test(p)) return { kind: 'derived', reason: 'fichero de bloqueo de dependencias' };
  if (GENERATED.test(p)) return { kind: 'derived', reason: 'código generado' };
  if (SNAPSHOT.test(p)) return { kind: 'derived', reason: 'snapshot de test' };
  const ext = path.extname(p);
  if (ext && ext !== '.tt' && allPaths.has(p.slice(0, -ext.length) + '.tt')) return { kind: 'derived', reason: 'salida de la plantilla .tt' };
  if (TEST.test(p) && /(^|\/)Resources\//.test(p)) return { kind: 'derived', reason: 'resultado esperado de test (snapshot)' };
  if (DOC.test(p) || /(^|\/)docs?\//i.test(p)) return { kind: 'doc', reason: 'documentación' };
  if (TEST.test(p)) return { kind: 'test', reason: 'test' };
  if (CONFIG.test(p)) return { kind: 'config', reason: 'configuración o proyecto' };
  return { kind: 'source', reason: 'código fuente' };
}

const norm = (l) => l.trim().replace(/\s+/g, ' ');

/**
 * Find groups of derived files that received the same edit. Derived files of the same kind under the same
 * top folder form a group; with ≥5 files, an added line counts as "mechanical" when it appears in at least
 * half of them. Whatever else a file changes is its anomaly, and anomalies are always routed to the human.
 */
export function mechanicalGroups(files) {
  const all = new Set(files.map((f) => f.path));
  const byDir = new Map();
  for (const f of files) {
    const c = classifyFile(f.path, all);
    if (c.kind !== 'derived') continue;
    const segs = f.path.split('/');
    const res = segs.indexOf('Resources');
    const dir = res > 0 ? segs.slice(0, res + 1).join('/') : path.dirname(f.path);
    const key = `${c.reason}|${dir}`;
    if (!byDir.has(key)) byDir.set(key, []);
    byDir.get(key).push(f);
  }
  const groups = [];
  for (const [key, list] of byDir) {
    const [reason, dir] = key.split('|');
    if (list.length < 5) continue;
    const freq = new Map();
    for (const f of list) {
      const seen = new Set(f.hunks.flatMap((h) => h.added.map(norm)).filter(Boolean));
      for (const l of seen) freq.set(l, (freq.get(l) || 0) + 1);
    }
    const common = new Set([...freq].filter(([, n]) => n >= Math.max(3, Math.ceil(list.length / 2))).map(([l]) => l));
    if (!common.size) continue;
    let mechanicalLines = 0;
    let occurrences = 0;
    const anomalies = [];
    for (const f of list) {
      const extraAdded = [];
      const removed = [];
      for (const h of f.hunks) {
        for (const l of h.added) {
          if (common.has(norm(l))) mechanicalLines++;
          else if (norm(l)) extraAdded.push({ line: l, at: h.newStart });
        }
        for (const l of h.removed) if (norm(l)) removed.push({ line: l, at: h.oldStart });
      }
      occurrences += f.hunks.filter((h) => h.added.some((l) => common.has(norm(l)))).length;
      if (extraAdded.length || removed.length) anomalies.push({ path: f.path, added: extraAdded.slice(0, 20), removed: removed.slice(0, 20) });
    }
    groups.push({
      dir, reason,
      files: list.length,
      pattern: [...common].slice(0, 8),
      mechanicalLines,
      occurrences,
      anomalies,
    });
  }
  return groups;
}

/** Old-side line range of a hunk, used to compare edits made from the same base. */
export const oldRange = (h) => [h.oldStart, h.oldStart + Math.max(h.oldLines, 1) - 1];

/** Test methods a diff adds (xUnit/NUnit/MSTest, pytest, jest/mocha). */
export function addedTestNames(files) {
  const names = new Set();
  for (const f of files) {
    for (const h of f.hunks) {
      const lines = h.added;
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        let m = l.match(/^\s*public\s+(?:async\s+)?(?:Task|void|ValueTask)\s+(\w+)\s*\(/);
        if (m) {
          const attr = lines.slice(Math.max(0, i - 4), i).join(' ');
          if (/\[(Fact|Theory|Test|TestMethod|TestCase|CombinatorialData)/.test(attr) || /Tests?\.cs$/.test(f.path)) names.add(m[1]);
          continue;
        }
        m = l.match(/^\s*def\s+(test_\w+)\s*\(/);
        if (m) { names.add(m[1]); continue; }
        m = l.match(/^\s*(?:it|test)\s*\(\s*['"`]([^'"`]+)['"`]/);
        if (m) names.add(m[1]);
      }
    }
  }
  return [...names];
}
