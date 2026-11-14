// Zone-by-zone comparison of several diffs against the same base.
// A zone is a range of base lines that at least one candidate touched (or a new file).
// In each zone, candidates are clustered by what they put there; "left it alone" is a valid answer too.
import { parseDiff } from '../git.js';

const tokens = (s) => String(s).replace(/\s+/g, ' ').match(/[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|\S/g) || [];

const MAX_TOKENS = 400; // per side, to bound the O(n·m) LCS

/**
 * Order-aware similarity over tokens: 2·LCS / (lenA + lenB) (1 = same token sequence).
 * Order matters, so `a - b` vs `b - a` no longer look identical. Both empty = 1; one empty = 0.
 */
export function similarity(a, b) {
  const ta = tokens(a).slice(0, MAX_TOKENS);
  const tb = tokens(b).slice(0, MAX_TOKENS);
  if (!ta.length && !tb.length) return 1;
  if (!ta.length || !tb.length) return 0;
  let prev = new Uint16Array(tb.length + 1);
  let cur = new Uint16Array(tb.length + 1);
  for (let i = 1; i <= ta.length; i++) {
    for (let j = 1; j <= tb.length; j++) {
      cur[j] = ta[i - 1] === tb[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    [prev, cur] = [cur, prev];
  }
  return (2 * prev[tb.length]) / (ta.length + tb.length);
}

const CLUSTER_AT = 0.82;
const isCode = (p) => !/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(p);

/**
 * diffs: { agentId: unifiedDiffText (-U0) }. baseLines(file) → array of base lines (sync or cached).
 * Returns { zones, matrix, agentIds }.
 */
export function buildHeatmap(diffs, baseLines = () => []) {
  const ids = Object.keys(diffs);
  const parsed = Object.fromEntries(ids.map((id) => [id, parseDiff(diffs[id] || '').filter((f) => !f.binary && isCode(f.path))]));

  // Collect intervals per file in base coordinates.
  const perFile = new Map();
  for (const id of ids) {
    for (const f of parsed[id]) {
      const key = f.status === 'added' ? `+${f.path}` : f.path;
      if (!perFile.has(key)) perFile.set(key, { path: f.path, added: f.status === 'added', hunks: [] });
      for (const h of f.hunks) {
        const start = f.status === 'added' ? 0 : h.oldLines === 0 ? h.oldStart + 0.5 : h.oldStart;
        const end = f.status === 'added' ? 0 : h.oldLines === 0 ? h.oldStart + 0.5 : h.oldStart + h.oldLines - 1;
        perFile.get(key).hunks.push({ id, start, end, h });
      }
    }
  }

  const zones = [];
  for (const { path, added, hunks } of perFile.values()) {
    hunks.sort((a, b) => a.start - b.start);
    const groups = [];
    for (const x of hunks) {
      const g = groups[groups.length - 1];
      if (g && (added || x.start <= g.end + 2)) { g.end = Math.max(g.end, x.end); g.items.push(x); }
      else groups.push({ start: x.start, end: x.end, items: [x] });
    }
    for (const g of groups) {
      const lines = added ? [] : baseLines(path);
      const s = Math.max(1, Math.floor(g.start));
      const e = Math.max(s, Math.ceil(g.end));
      const cells = {};
      for (const id of ids) {
        const mine = g.items.filter((x) => x.id === id);
        // Removed lines count too: deleting different base lines (or replacing vs inserting) is a different change.
        const text = mine.map((x) => [...x.h.removed.map((l) => `- ${l}`), ...x.h.added.map((l) => `+ ${l}`)].join('\n')).join('\n');
        cells[id] = { touched: mine.length > 0, text: mine.length ? text : '' };
      }
      // Greedy clustering of the cell texts (untouched cells cluster with each other: "keep the base").
      const clusters = [];
      for (const id of ids) {
        const c = clusters.find((k) => cells[k[0]].touched === cells[id].touched && similarity(cells[k[0]].text, cells[id].text) >= CLUSTER_AT);
        if (c) c.push(id); else clusters.push([id]);
      }
      clusters.sort((a, b) => b.length - a.length);
      clusters.forEach((c, i) => c.forEach((id) => { cells[id].cluster = i; cells[id].agree = c.length / ids.length; }));
      if (cells.PR) for (const id of ids) cells[id].same_as_pr = cells[id].cluster === cells.PR.cluster;
      zones.push({
        id: `z${zones.length + 1}`,
        file: path,
        newFile: added,
        start: added ? 0 : s,
        end: added ? 0 : e,
        base: added ? '(fichero nuevo)' : lines.slice(s - 1, Math.min(e, s + 11)).join('\n'),
        cells,
        agreement: clusters[0].length / ids.length,
        clusters,
      });
    }
  }
  zones.sort((a, b) => a.file.localeCompare(b.file) || a.start - b.start);

  // Pairwise similarity: average over the zones at least one of the two touched
  // (zones both left alone, i.e. touched only by others, would dilute real differences). None = identical.
  const matrix = {};
  for (const a of ids) {
    matrix[a] = {};
    for (const b of ids) {
      if (a === b) { matrix[a][b] = 1; continue; }
      let sum = 0;
      let n = 0;
      for (const z of zones) {
        const ca = z.cells[a];
        const cb = z.cells[b];
        if (!ca.touched && !cb.touched) continue;
        n++;
        sum += ca.touched !== cb.touched ? 0 : similarity(ca.text, cb.text);
      }
      matrix[a][b] = n ? Math.round((sum / n) * 100) / 100 : 1;
    }
  }
  // Exact agreement: identical code in every zone (whitespace ignored). Only this lets candidates skip the debate;
  // a high similarity score can hide a one-character bug (> vs >=, a dropped !).
  const norm = (t) => String(t).replace(/\s+/g, '');
  const exact = {};
  for (const a of ids) {
    exact[a] = {};
    for (const b of ids) exact[a][b] = a === b || zones.every((z) => z.cells[a].touched === z.cells[b].touched && norm(z.cells[a].text) === norm(z.cells[b].text));
  }
  return { zones, matrix, exact, agentIds: ids };
}

/** Zones where two candidates disagree, rendered as compact text for a prompt. */
export function disagreements(heatmap, a, b, max = 8) {
  const out = [];
  for (const z of heatmap.zones) {
    const ca = z.cells[a];
    const cb = z.cells[b];
    if (ca.cluster === cb.cluster) continue;
    out.push(`### ${z.file}${z.newFile ? ' (nuevo)' : `:${z.start}-${z.end}`}\nBase:\n${z.base || '(vacío)'}\n${a} pone:\n${ca.touched ? ca.text : '(lo deja como está)'}\n${b} pone:\n${cb.touched ? cb.text : '(lo deja como está)'}`);
    if (out.length >= max) break;
  }
  return out.join('\n\n');
}
