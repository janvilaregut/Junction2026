import fs from 'node:fs';
import path from 'node:path';
import { run, ROOT, sha256, writeJSON } from '../util.js';
import { out } from '../git.js';
import { models, session } from '../agents.js';

export const contractHash = c => sha256(JSON.stringify({ version: c.version, expectations: c.expectations, sources: c.sources }));

export function validateContract(value, sources) {
  if (!Array.isArray(value.expectations) || !value.expectations.length) throw new Error('Contract requires expectations');
  const expectations = value.expectations.slice(0, 12).map((e, i) => {
    const refs = (e.sources || []).filter(r => sources.some(s => s.id === r.id && typeof r.quote === 'string' && r.quote.length >= 8 && s.text.includes(r.quote)));
    return { id: `E${i + 1}`, behavior: String(e.behavior || ''), critical: e.critical !== false,
      status: refs.length && e.status === 'documented' ? 'documented' : refs.length && e.status === 'inferred' ? 'inferred' : 'pending', sources: refs,
      testIdeas: Array.isArray(e.testIdeas) ? e.testIdeas : [], symbols: Array.isArray(e.symbols) ? e.symbols : [] };
  });
  const c = { version: 1, expectations, sources, ambiguities: value.ambiguities || [] };
  c.hash = contractHash(c); return c;
}

export async function analyzeSymbols(it, dir, artifacts) {
  const files = (await out(it.repo, ['ls-tree', '-r', '--name-only', it.mergeBase])).split('\n')
    .filter(p => p.endsWith('.cs') && /^(src|tests)\//.test(p) && !/generated|\.g\.cs|TestData|Resources/i.test(p)).slice(0, 1500);
  const changes = it.files.filter(f => f.kind === 'source' && f.path.endsWith('.cs')).map(f => ({ file: f.path, lines: f.hunks.flatMap(h => Array.from({ length: Math.max(h.oldLines, 1) }, (_, i) => h.oldStart + i)) }));
  const manifest = path.join(artifacts, 'roslyn-input.json'); writeJSON(manifest, { root: dir, files, changes });
  const dll = path.join(ROOT, 'tools/Katse.Analyze/bin/Release/net8.0/Katse.Analyze.dll');
  const build = await run('dotnet', ['build', path.join(ROOT, 'tools/Katse.Analyze/Katse.Analyze.csproj'), '-c', 'Release', '-v', 'q'], { timeout: 60_000 });
  if (build.code) return { symbols: [], limitation: 'Roslyn helper build failed', error: build.stdout + build.stderr };
  const r = await run('dotnet', [dll, manifest], { timeout: 60_000 });
  if (r.code) return { symbols: [], limitation: 'Roslyn analysis failed', error: r.stderr };
  const parsed = JSON.parse(r.stdout); writeJSON(path.join(artifacts, 'roslyn.json'), parsed); return parsed;
}

export async function reconstructContract(it, dir, artifacts, emit) {
  const sources = [];
  if (it.requirement?.body || it.requirement?.title) sources.push({ id: 'requirement', kind: 'requirement', uri: it.requirement.url || 'user-input', text: `${it.requirement.title}\n${it.requirement.body || ''}`.slice(0, 16000) });
  for (const f of it.files.filter(f => f.kind === 'test' || /\.md$/i.test(f.path)).slice(0, 5)) {
    try {
      const text = await out(it.repo, ['show', `${it.mergeBase}:${f.path}`]); const lines = text.split('\n');
      const excerpt = text.length <= 5000 ? text : f.hunks.map(h => lines.slice(Math.max(0, h.oldStart - 30), h.oldStart + Math.max(20, h.oldLines) + 15).join('\n')).join('\n').slice(0, 6500);
      sources.push({ id: `base-${sources.length}`, kind: f.kind === 'test' ? 'test' : 'documentation', uri: `${it.mergeBase}:${f.path}`, text: excerpt });
    } catch {}
  }
  for (const c of it.provenance.checkpoints || []) for (const p of c.prompts || []) sources.push({ id: `prompt-${sources.length}`, kind: 'user-prompt', uri: `entire:${c.checkpoint}:${p.line}`, text: p.text });
  const prompt = `Reconstruct a testable contract using ONLY the supplied sources BEFORE the proposed patch. NO tools; all context is supplied below. Never infer that the author's implementation is correct. Max 5 expectations. Each expectation must cite an exact source substring with id and quote (at least 8 characters). Distinguish documented behavior, inferred preservation behavior and pending ambiguities. Preserve diagnostics unrelated to the requested fix. Return JSON {"expectations":[{"behavior":"...","critical":true,"status":"documented|inferred|pending","sources":[{"id":"...","quote":"exact excerpt"}],"testIdeas":["..."],"symbols":["..."]}],"ambiguities":[]}. Do not edit files. Sources:\n${JSON.stringify(sources).slice(0, 65000)}`;
  const analyst = await session({ dir, artifacts, role: 'contract', model: models().fast, prompt, validate: x => Array.isArray(x.expectations) });
  let contract = validateContract(analyst.result, sources);
  const review = await session({ dir, artifacts, role: 'contract-review', model: models().review, prompt: `Review the contract against the cited sources below, NO tools. Correct overclaims or mark ambiguity pending. Same JSON schema. Max5 expectations. Do not edit files.\n${JSON.stringify(contract).slice(0, 65000)}`, validate: x => Array.isArray(x.expectations) });
  contract = validateContract(review.result, sources); contract.sessions = [analyst.id, review.id];
  contract.sessionRecords = [analyst, review].map(({ result, ...r }) => r);
  writeJSON(path.join(artifacts, 'contract.json'), contract); emit({ type: 'contract', hash: contract.hash, expectations: contract.expectations }); return contract;
}

export function behaviorGroups(it, analysis, contract) {
  const symbols = analysis.symbols || [];
  const groups = symbols.map(s => ({ file: s.file, symbol: s.name, start: s.start, end: s.end, conditions: s.conditions, references: s.references }));
  // Newly introduced symbols have no declaration in the base. Keep their hunks
  // as explicit unbound groups rather than silently dropping their behavior.
  for (const f of it.files.filter(f => f.kind === 'source')) for (const h of f.hunks) {
    if (!groups.some(g => g.file === f.path && h.oldStart >= g.start && h.oldStart <= g.end)) groups.push({ file: f.path, symbol: null, start: h.oldStart, end: h.oldStart + Math.max(1, h.oldLines) - 1, references: [], fallback: true });
  }
  return groups.map((g, i) => {
    const source = it.files.find(f => f.path === g.file);
    const changed = source?.hunks.filter(h => h.oldStart <= g.end && h.oldStart + Math.max(1, h.oldLines) >= g.start);
    const shared = /diagnostic|authorization|persist|public |catch\b|filter/i.test(changed?.flatMap(h => [...h.added, ...h.removed]).join('\n') || '');
    const linked = contract.expectations.filter(e => e.symbols.some(s => g.symbol?.includes(s)));
    return { ...g, id: `G${i + 1}`, risk: shared ? 3 : 2, riskReason: shared ? 'Shared diagnostic, public contract or error-filter changes' : 'Executable behavior change', expectations: (linked.length ? linked : contract.expectations).map(e => e.id), expectationMapping: linked.length ? 'contract-symbol-names' : 'conservative-file-scope', unverified: 1, disagreement: null, estimatedMs: 90000, explored: 0 };
  });
}
