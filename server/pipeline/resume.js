import fs from 'node:fs';
import path from 'node:path';
import { DATA } from '../util.js';
import { verifyIntegrity } from '../integrity.js';
import { contractHash } from './contract.js';

export function loadContinuation(projectId, runId, input, destination) {
  if (['.','..'].includes(projectId) || ['.','..'].includes(runId) || !/^[\w.-]+$/.test(projectId) || !/^[\w.-]+$/.test(runId)) throw new Error('Invalid continuation ID');
  const origin = path.join(DATA, 'runs', projectId, runId, 'artifacts');
  const brief = JSON.parse(fs.readFileSync(path.join(origin, 'brief.json'), 'utf8'));
  const state = JSON.parse(fs.readFileSync(path.join(origin, 'pipeline.json'), 'utf8'));
  if (!verifyIntegrity(brief, origin).ok || !state.contract || state.contract.hash !== contractHash(state.contract) || state.contract.hash !== brief.contract?.hash) throw new Error('Continuation evidence or contract changed');
  for (const key of ['proposed', 'target', 'historicalBase']) if (state.input[key] !== input[key]) throw new Error('Continuation code/base changed; start a fresh review');
  if (JSON.stringify(state.input.requirement) !== JSON.stringify(input.requirement)) throw new Error('Continuation requirement changed; start a fresh review');
  // Preserve immutable evidence for inspection, but reexecute tests in the current environment.
  for (const name of Object.keys(brief.artifactManifest)) if (/^[\w.-]+$/.test(name) && !['brief.json','pipeline.json'].includes(name) && fs.statSync(path.join(origin,name)).isFile()) fs.copyFileSync(path.join(origin,name),path.join(destination,name));
  return { state, origin, runId, reuse: 'contract, admitted scenarios, candidate patches and transcripts; execution results recalculated' };
}
