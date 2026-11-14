import fs from 'node:fs';
import path from 'node:path';

// Apply literal, unique edits. Never let a model choose commands or traverse paths.
export function applyProposal(dir, edits, allowedPaths, blocks = []) {
  if (!Array.isArray(edits) || !edits.length || edits.length > 12) throw new Error('proposal-edits');
  const changes = new Map();
  for (const proposed of edits) {
    const block = blocks.find(b=>b.id===proposed.block);
    if(proposed.block && !block) throw new Error('proposal-block');
    const e = block ? {path:block.path,old:block.text,new:proposed.new} : proposed;
    if (!allowedPaths.includes(e.path) || !e.path.startsWith('src/') || !e.path.endsWith('.cs') || e.path.includes('..') || e.path.includes('\\')) throw new Error('proposal-path');
    if (typeof e.old !== 'string' || !e.old.trim() || typeof e.new !== 'string' || e.new.length > 16000) throw new Error('proposal-content');
    const current = changes.get(e.path) ?? fs.readFileSync(path.join(dir, e.path), 'utf8').replaceAll('\r\n', '\n');
    const old = e.old.replaceAll('\r\n', '\n');
    if (current.split(old).length !== 2) throw new Error('proposal-match-must-be-unique');
    changes.set(e.path, current.replace(old, () => e.new.replaceAll('\r\n', '\n')));
  }
  for (const [file, content] of changes) fs.writeFileSync(path.join(dir, file), content);
  return [...changes.keys()];
}


// Run after the concurrent construction/capture tasks settle. A per-candidate
// check can miss a sibling which has the same tree but is still capturing.
// Stable candidate IDs choose the representative independently of array order.
export function deduplicateCandidates(candidates) {
  const representatives = new Map();
  const duplicates = [];
  const built = candidates.filter(c => c.status === 'built' && typeof c.tree === 'string' && c.tree.length > 0)
    .sort((a, b) => String(a.id).localeCompare(String(b.id), 'en', { numeric: true }));
  for (const candidate of built) {
    const existing = representatives.get(candidate.tree);
    if (!existing) { representatives.set(candidate.tree, candidate); continue; }
    candidate.status = 'duplicate';
    candidate.duplicateOf = existing.id;
    candidate.deduplication = 'Same complete source tree after all concurrent candidates settled';
    // Keep all patch, model, session and checkpoint metadata for audit.
    duplicates.push({ id: candidate.id, duplicateOf: existing.id, tree: candidate.tree, reason: candidate.deduplication });
  }
  return { distinct: representatives.size, duplicates, unchecked: candidates.filter(c => c.status === 'built' && !c.tree).map(c => c.id) };
}
