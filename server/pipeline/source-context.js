// Source-only context: changed locations plus expressions named in the requirement.
// The caller supplies the historical base (or a candidate parent), never the proposed patch.
export function sourceBlocks(files, requirement = '') {
  const mentioned = [...new Set([...requirement.matchAll(/`([A-Za-z_]\w*(?:\.\w+)*(?:\[[^\]\n]{1,20}\])?)`/g)]
    .map(m => m[1]).filter(s => s.length >= 8))].slice(0, 20);
  // A precise failing expression is more useful than every caller named in a stack trace.
  const indexed = mentioned.filter(s=>s.includes('['));
  const terms = indexed.length ? indexed : mentioned.slice(0,8);
  const blocks = [];
  for (const file of files) {
    const lines = file.text.replaceAll('\r\n', '\n').split('\n');
    const ranges = file.hunks.map(h => [Math.max(0, h.oldStart - 7), Math.min(lines.length, h.oldStart + h.oldLines + 7)]);
    for (const term of terms) {
      let count = 0;
      for (let i = 0; i < lines.length && count < 4; i++) if (lines[i].includes(term)) {
        ranges.push([Math.max(0, i - 7), Math.min(lines.length, i + 9)]); count++;
      }
    }
    const merged = [];
    for (const r of ranges.sort((a, b) => a[0] - b[0])) {
      const last = merged.at(-1);
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else merged.push([...r]);
    }
    for (const [start, end] of merged) blocks.push({ id: `B${blocks.length + 1}`, path: file.path, start: start + 1, text: lines.slice(start, end).join('\n') });
  }
  return blocks;
}
