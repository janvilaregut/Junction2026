// Mutation: plant small, known defects in the lines the PR changed and see whether the tests notice.
// It answers two questions at once:
//   - do the PR's tests have teeth? (a surviving mutant means a line no test protects)
//   - would this review catch a seeded defect? (caught by tests, or at least routed to the human)
import fs from 'node:fs';
import path from 'node:path';

const OPS = [
  ['quita el acceso seguro', /FirstOrDefault\(\)\?\./, 'First().'],
  ['niega la condición', /^(\s*(?:else\s+)?if\s*\()(.*)(\)\s*\{?\s*)$/, (m, a, b, c) => `${a}!(${b})${c}`],
  ['cambia && por ||', / && /, ' || '],
  ['cambia || por &&', / \|\| /, ' && '],
  ['cambia == por !=', / == /, ' != '],
  ['cambia != por ==', / != /, ' == '],
  ['invierte is null', /\bis null\b/, 'is not null'],
  ['invierte is not null', /\bis not null\b/, 'is null'],
  ['quita ?.', /\?\./, '.'],
  ['elimina la sentencia', /^(\s*)(?:[\w.]+\([^;]*\);|continue;|break;|return;)\s*(?:\/\/.*)?$/, '$1/* mutante: sentencia eliminada */'],
  ['invierte true', /\btrue\b/, 'false'],
  ['invierte false', /\bfalse\b/, 'true'],
  ['cambia + por -', / \+ (?=\w)/, ' - '],
  ['cambia < por >=', / < /, ' >= '],
  ['cambia > por <=', / > /, ' <= '],
];

const isCode = (l) => {
  const t = l.trim();
  return t.length > 2 && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('#') && !t.startsWith('using ') && !t.startsWith('import ');
};

/** One candidate mutant per changed code line, spread over different operators and lines. */
export function candidates(prFiles, max) {
  const all = [];
  for (const f of prFiles) {
    if (f.kind !== 'source' || f.status === 'deleted' || /\.(tt|md|json|xml|csproj)$/.test(f.path)) continue;
    for (const h of f.hunks) {
      h.added.forEach((line, i) => {
        if (!isCode(line)) return;
        for (const [name, re, rep] of OPS) {
          if (!re.test(line)) continue;
          const mutated = line.replace(re, rep);
          if (mutated !== line) { all.push({ file: f.path, line: h.newStart + i, original: line, mutated, op: name }); break; }
        }
      });
    }
  }
  // Round-robin by operator so a handful of mutants covers different kinds of mistakes.
  const byOp = new Map();
  for (const c of all) { if (!byOp.has(c.op)) byOp.set(c.op, []); byOp.get(c.op).push(c); }
  const picked = [];
  while (picked.length < max && [...byOp.values()].some((l) => l.length)) {
    for (const list of byOp.values()) {
      if (picked.length >= max) break;
      const c = list.shift();
      if (c) picked.push(c);
    }
  }
  return { picked, available: all.length };
}

function applyAt(file, cand) {
  const text = fs.readFileSync(file, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const want = cand.original.replace(/\r$/, '');
  // The merged tree may have shifted lines; look for the exact text nearest to where the diff put it.
  let idx = -1;
  for (let d = 0; d < lines.length && idx < 0; d++) {
    for (const i of [cand.line - 1 - d, cand.line - 1 + d]) {
      if (i >= 0 && i < lines.length && lines[i] === want) { idx = i; break; }
    }
  }
  if (idx < 0) return null;
  lines[idx] = cand.mutated.replace(/\r$/, '');
  fs.writeFileSync(file, lines.join(eol));
  return text;
}

export async function runMutation({ tree, prFiles, toolchain, max, emit }) {
  const { picked, available } = candidates(prFiles, max);
  const mutants = [];
  for (const [n, cand] of picked.entries()) {
    const abs = path.join(tree, cand.file);
    const original = applyAt(abs, cand);
    if (original === null) { mutants.push({ ...cand, status: 'no-aplicado' }); continue; }
    emit?.(`Mutante ${n + 1}/${picked.length}: ${cand.op} en ${path.basename(cand.file)}:${cand.line}`);
    try {
      const b = await toolchain.build(tree);
      if (!b.ok) { mutants.push({ ...cand, status: 'no-compila' }); continue; }
      const t = await toolchain.test(tree, {});
      const killers = t.tests.filter((x) => x.outcome === 'Failed').map((x) => x.name);
      mutants.push({ ...cand, status: killers.length ? 'detectado' : 'sobrevive', killers: killers.slice(0, 5), killerCount: killers.length });
    } finally {
      fs.writeFileSync(abs, original);
    }
  }
  const valid = mutants.filter((m) => m.status === 'detectado' || m.status === 'sobrevive');
  return {
    available, mutants,
    valid: valid.length,
    killed: valid.filter((m) => m.status === 'detectado').length,
    survived: valid.filter((m) => m.status === 'sobrevive').length,
  };
}
