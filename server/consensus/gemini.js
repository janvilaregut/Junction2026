// Minimal Gemini client (generateContent) with retries. The key comes from .env or the environment and never leaves this machine except to Google.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from '../util.js';
import { assertLegacyCloudAllowed } from '../privacy.js';

export const TOP_MODEL = process.env.KATSE_GEMINI_MODEL || 'gemini-4-carbon';
const API = 'https://generativelanguage.googleapis.com/v1beta/models';

/** GEMINI_API_KEY from the environment, this checkout's .env, or the main checkout's .env (git worktrees share it). */
function loadKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  const dirs = [ROOT];
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    dirs.push(path.dirname(common));
  } catch { /* not a git checkout */ }
  for (const d of dirs) {
    try {
      const m = fs.readFileSync(path.join(d, '.env'), 'utf8').match(/^\s*GEMINI_API_KEY\s*=\s*"?([^"\n]+)"?/m);
      if (m) return m[1].trim();
    } catch { /* no .env here */ }
  }
  return null;
}

export const hasKey = () => Boolean(loadKey());

const abortError = (signal) => signal.reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' });
/** Sleep that rejects as soon as `signal` aborts (so a cut-off does not wait out the backoff). */
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(abortError(signal));
  const onAbort = () => { clearTimeout(t); reject(abortError(signal)); };
  const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  signal?.addEventListener('abort', onAbort, { once: true });
});
let thinkingUnsupported = false;

/**
 * One generateContent call. `gen` holds sampling params ({temperature, topP, topK, thinkingLevel}).
 * Returns { content, text, calls, raw }. `content` is the model turn exactly as returned (keeps thought signatures).
 */
export async function generate({ model = TOP_MODEL, contents, system, tools, gen = {}, json = false, signal }) {
  assertLegacyCloudAllowed();
  const key = loadKey();
  if (!key) throw new Error('GEMINI_API_KEY missing (put it in .env)');
  const generationConfig = {};
  for (const k of ['temperature', 'topP', 'topK', 'maxOutputTokens']) if (gen[k] !== undefined) generationConfig[k] = gen[k];
  if (gen.thinkingLevel && !thinkingUnsupported) generationConfig.thinkingConfig = { thinkingLevel: gen.thinkingLevel };
  if (json) generationConfig.responseMimeType = 'application/json';
  const body = { contents, generationConfig };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (tools) body.tools = [{ functionDeclarations: tools }];

  let lastErr;
  for (let attempt = 0; attempt < 6; attempt++) {
    if (signal?.aborted) throw abortError(signal);
    let res;
    try {
      res = await fetch(`${API}/${model}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (signal?.aborted || e?.name === 'AbortError') throw e; // cancelled, not a network error: do not retry
      lastErr = e;
      await sleep(1500 * (attempt + 1), signal);
      continue;
    }
    const raw = await res.text();
    if (res.ok) {
      let j;
      try { j = JSON.parse(raw); } catch { lastErr = new Error('Non-JSON response from Gemini'); await sleep(1000, signal); continue; }
      const cand = j.candidates?.[0];
      const content = cand?.content || { role: 'model', parts: [] };
      if (!content.role) content.role = 'model';
      const parts = content.parts || [];
      const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('');
      const calls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);
      if (!parts.length && attempt < 5) { lastErr = new Error(`Empty response (${cand?.finishReason || j.promptFeedback?.blockReason || '?'})`); await sleep(1000, signal); continue; }
      return { content, text, calls, raw: j, usage: j.usageMetadata };
    }
    if (res.status === 400 && generationConfig.thinkingConfig && /thinking/i.test(raw)) {
      thinkingUnsupported = true;
      delete generationConfig.thinkingConfig;
      continue;
    }
    lastErr = new Error(`Gemini ${res.status}: ${raw.slice(0, 300)}`);
    if (res.status === 400 || res.status === 401 || res.status === 403) break;
    await sleep(Math.min(20_000, 2000 * 2 ** attempt), signal); // 429 / 5xx / spurious 404
  }
  throw lastErr;
}

/** Ask for a JSON object; tolerant parsing. */
export async function generateJSON(opts) {
  const r = await generate({ ...opts, json: true });
  return parseJSON(r.text);
}

export function parseJSON(text) {
  try { return JSON.parse(text); } catch { /* fallthrough */ }
  const m = String(text).match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* fallthrough */ } }
  throw new Error(`Invalid JSON from Gemini: ${String(text).slice(0, 200)}`);
}
