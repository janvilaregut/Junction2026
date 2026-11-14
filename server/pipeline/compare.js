// Compare the PR with the replicas, region by region.
// A region is one hunk of hand-written source, or one whole test / doc file.
// Statuses per replica: same (equivalent edit) · different (touched the same place another way) · absent.
// Agreement only tells the human where to look. It is never used as proof that the code is right.
import path from 'node:path';
import { classifyFile, oldRange } from './classify.js';

const stripComments = (l) => l.replace(/\/\/.*$/, '').replace(/^\s*(\*|\/\*).*$/, '').replace(/^\s*#(?!if|else|endif|pragma).*$/, '');
const tokens = (lines) => new Set(lines.flatMap((l) => stripComments(l).match(/[A-Za-z_]\w*|\d+|[=!<>]=|&&|\|\||\?\.|\?\?/g) || []));

function jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter || 1);
}

const overlaps = ([a1, a2], [b1, b2], pad = 6) => a1 - pad <= b2 && b1 - pad <= a2;
const isCommentOnly = (h) => [...h.added, ...h.removed].every((l) => !stripComments(l).trim());

export function withKinds(files) {
  const all = new Set(files.map((f) => f.path));
  return files.map((f) => ({ ...f, ...classifyFile(f.path, all) }));
}

/** Regions of the PR that a human could be asked to read. Derived files are handled by level 1. */
export function prRegions(prFiles) {
  const regions = [];
  let n = 0;
  for (const f of prFiles) {
    if (f.kind === 'derived' || f.binary) continue;
    const base = { file: f.path, kind: f.kind };
    if (f.kind === 'test' || f.kind === 'doc' || f.status === 'added') {
      const added = f.hunks.flatMap((h) => h.added);
      regions.push({
        ...base, id: `R${++n}`, whole: true, newStart: f.hunks[0]?.newStart || 1,
        newEnd: (f.hunks.at(-1)?.newStart || 1) + Math.max((f.hunks.at(-1)?.newLines || 1) - 1, 0),
        lines: f.add + f.del, added: added.slice(0, 400), removed: [],
        label: f.status === 'added' ? `fichero nuevo ${path.basename(f.path)}` : `${f.kind === 'test' ? 'tests' : 'documentación'} en ${path.basename(f.path)}`,
        hunks: f.hunks,
      });
      continue;
    }
    for (const h of f.hunks) {
      regions.push({
        ...base, id: `R${++n}`, whole: false, newStart: h.newStart, newEnd: h.newStart + Math.max(h.newLines - 1, 0),
        lines: h.added.length + h.removed.length, added: h.added, removed: h.removed,
        commentOnly: isCommentOnly(h), old: oldRange(h), hunks: [h],
        label: firstCodeLine(h) || `líneas ${h.newStart}`,
      });
    }
  }
  return regions;
}

function firstCodeLine(h) {
  const l = [...h.added, ...h.removed].map((x) => stripComments(x).trim()).find((x) => x.length > 3);
  return l ? (l.length > 70 ? l.slice(0, 67) + '…' : l) : '';
}

function statusFor(region, replica) {
  const rf = replica.files;
  if (region.kind === 'test') return rf.some((f) => f.kind === 'test' && f.add > 0) ? 'same' : 'absent';
  if (region.kind === 'doc') return rf.some((f) => f.kind === 'doc' && f.add > 0) ? 'same' : 'absent';
  const mine = tokens([...region.added, ...region.removed]);
  if (region.whole) {
    // A new source file: look for a new source file with similar content anywhere in the replica.
    const news = rf.filter((f) => f.status === 'added' && f.kind === region.kind);
    const best = Math.max(0, ...news.map((f) => jaccard(mine, tokens(f.hunks.flatMap((h) => h.added)))));
    if (best >= 0.3) return 'same';
    return news.length ? 'different' : 'absent';
  }
  const file = rf.find((f) => f.path === region.file);
  if (!file) return 'absent';
  const near = file.hunks.filter((h) => overlaps(region.old, oldRange(h)));
  if (near.length) {
    const sim = jaccard(mine, tokens(near.flatMap((h) => [...h.added, ...h.removed])));
    return sim >= 0.5 ? 'same' : 'different';
  }
  // Same edit placed elsewhere in the file (for example a helper added at a different position).
  const anywhere = Math.max(0, ...file.hunks.map((h) => jaccard(mine, tokens([...h.added, ...h.removed]))));
  return anywhere >= 0.6 ? 'same' : 'absent';
}

export function compareRegions(prFiles, replicas) {
  const ok = replicas.filter((r) => r.ok);
  const need = ok.length <= 1 ? 1 : Math.max(2, Math.ceil(ok.length * 0.6));
  const regions = prRegions(prFiles).map((region) => {
    const cells = ok.map((r) => ({ replica: r.id, status: statusFor(region, r) }));
    const same = cells.filter((c) => c.status === 'same').length;
    const different = cells.filter((c) => c.status === 'different').length;
    let verdict;
    if (!ok.length) verdict = 'unknown';
    else if (region.commentOnly) verdict = 'trivial';
    else if (same >= need) verdict = 'consensus';
    else if (same + different === 0) verdict = 'surplus';
    else verdict = 'divergent';
    return { ...region, hunks: undefined, cells, same, different, n: ok.length, verdict };
  });
  return { regions, omissions: omissions(prFiles, ok, need), n: ok.length, need };
}

/** Places most replicas changed and the PR did not: a hint that the PR may have missed something. */
function omissions(prFiles, replicas, need) {
  if (replicas.length < 2) return [];
  const clusters = [];
  for (const r of replicas) {
    for (const f of r.files) {
      if (f.kind !== 'source' || f.status === 'added') continue;
      for (const h of f.hunks) {
        if (isCommentOnly(h)) continue;
        const range = oldRange(h);
        let c = clusters.find((x) => x.file === f.path && overlaps(x.range, range, 3));
        if (!c) { c = { file: f.path, range: [...range], replicas: new Set(), sample: firstCodeLine(h) }; clusters.push(c); }
        c.range = [Math.min(c.range[0], range[0]), Math.max(c.range[1], range[1])];
        c.replicas.add(r.id);
      }
    }
  }
  return clusters
    .filter((c) => c.replicas.size >= need)
    .filter((c) => {
      const pf = prFiles.find((f) => f.path === c.file);
      return !pf || !pf.hunks.some((h) => overlaps(c.range, oldRange(h), 6));
    })
    .map((c) => ({ file: c.file, lines: c.range, replicas: [...c.replicas], sample: c.sample }));
}
