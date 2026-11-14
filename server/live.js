// Gemini Live for the voice mascot. The browser never sees the API key: it gets a single-use ephemeral token
// and talks to Gemini directly over WebSocket (BidiGenerateContentConstrained).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from './util.js';

export const LIVE_MODEL = process.env.KATSE_LIVE_MODEL || 'gemini-3.8-live';
export const LIVE_VOICE = process.env.KATSE_LIVE_VOICE || 'Puck';

/** GEMINI_API_KEY from the environment, this checkout's .env, or the main checkout's .env (worktrees share it). */
function apiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  const dirs = [ROOT];
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: ROOT, encoding: 'utf8' }).trim();
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

export async function liveToken() {
  const key = apiKey();
  if (!key) throw new Error('GEMINI_API_KEY missing: put it in .env');
  const now = Date.now();
  const r = await fetch('https://generativelanguage.googleapis.com/v1alpha/auth_tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ uses: 1, expireTime: new Date(now + 30 * 60e3).toISOString(), newSessionExpireTime: new Date(now + 60e3).toISOString() }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.name) throw new Error(`Could not create a Live token: ${j.error?.message || r.status}`);
  return {
    token: j.name,
    model: LIVE_MODEL,
    voice: LIVE_VOICE,
    url: 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained',
  };
}
