// Settings a person changes from the UI (gear on the home screen), saved in data/settings.json.
// Models: which ones the review pipeline may call. Nemotron (NVIDIA, served by Verda) is on by default (it needs
// VERDA_INFERENCE_KEY in .env); switched off, the pipeline never calls it and Hydrogen takes its place (recorded in the report).
import path from 'node:path';
import { DATA, readJSON, writeJSON } from './util.js';

const FILE = path.join(DATA, 'settings.json');
const DEFAULTS = { models: { hydrogen: true, carbon: true, nemotron: true } };
let cache = null;

export function getSettings() {
  if (!cache) { const saved = readJSON(FILE, {}) || {}; cache = { models: { ...DEFAULTS.models, ...(saved.models || {}) } }; }
  return structuredClone(cache);
}

export function updateSettings(patch = {}) {
  const models = { ...getSettings().models };
  for (const k of Object.keys(DEFAULTS.models)) if (typeof patch.models?.[k] === 'boolean') models[k] = patch.models[k];
  if (!models.hydrogen && !models.carbon) throw new Error('Keep at least one Gemini model on: the review needs it.');
  cache = { models };
  writeJSON(FILE, cache);
  return getSettings();
}
