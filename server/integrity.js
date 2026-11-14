import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from './util.js';
import { contractHash } from './pipeline/contract.js';

export function artifactManifest(dir) {
  return Object.fromEntries(fs.readdirSync(dir).filter(f => f !== 'brief.json' && fs.statSync(path.join(dir, f)).isFile()).sort().map(f => [f, sha256(fs.readFileSync(path.join(dir, f)))]));
}

export function verifyIntegrity(brief, artifacts) {
  if (brief.version < 2) return { ok: true, legacy: true };
  const errors = [];
  if (!brief.contract || contractHash(brief.contract) !== brief.contract.hash) errors.push('contract-changed');
  const manifest = artifactManifest(artifacts);
  for (const [file, hash] of Object.entries(brief.artifactManifest || {})) if (manifest[file] !== hash) errors.push(`artifact-changed:${file}`);
  if (!brief.artifactManifest || !Object.keys(brief.artifactManifest).length) errors.push('manifest-missing');
  return { ok: errors.length === 0, errors };
}
