// One place that knows how to call a model without interaction. Used for wording only (the judge's
// questions and the assistant's free-form answers), never to decide anything.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, toolEnv, which } from './util.js';

/**
 * Wording calls must not be able to change anything. They run in an empty temporary folder outside any
 * repository, with the read-only agent where the CLI has one, and inside the macOS sandbox with every
 * write denied except that folder. (Without this, a model asked to phrase a question once edited the
 * repository under review.)
 */
function readOnly(cmd, args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'katse-ask-'));
  if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec')) return { cmd, args, dir };
  const real = fs.realpathSync(dir);
  const home = os.homedir();
  const profile = [
    '(version 1)', '(allow default)',
    '(deny file-write* (subpath "/Users") (subpath "/private/var/folders") (subpath "/private/tmp") (subpath "/tmp") (subpath "/Volumes"))',
    // The CLI keeps its own state and cache in the home folder; allow only those.
    `(allow file-write* (subpath "${real}") (subpath "${home}/.local/share/opencode") (subpath "${home}/.local/state/opencode") (subpath "${home}/.cache/opencode") (subpath "${home}/.config/opencode") (subpath "${home}/.claude") (subpath "${home}/.claude.json") (subpath "${home}/Library/Caches"))`,
  ].join('\n');
  return { cmd: '/usr/bin/sandbox-exec', args: ['-p', profile, cmd, ...args], dir };
}

/** Environment for agent CLIs: drop variables a parent Claude session leaves behind, so the CLI uses its own login. */
export function agentEnv() {
  const env = toolEnv();
  for (const k of Object.keys(env)) {
    if (k === 'CLAUDECODE' || k === 'CLAUDE_PID' || k === 'CLAUDE_EFFORT' || k.startsWith('CLAUDE_CODE_') || k.startsWith('CLAUDE_AGENT_SDK') || k.startsWith('CLAUDE_PREVIEW') || k === 'ANTHROPIC_BASE_URL') delete env[k];
  }
  return env;
}

let cache = { at: 0, value: null };

/** Which CLIs are installed and actually usable right now. Cached for a minute. */
export async function clis() {
  if (Date.now() - cache.at < 60_000 && cache.value) return cache.value;
  const [claudePath, opencodePath] = await Promise.all([which('claude'), which('opencode')]);
  let claude = false;
  if (claudePath) {
    const r = await run('claude', ['auth', 'status'], { timeout: 20_000, env: agentEnv() });
    try { claude = JSON.parse(r.stdout).loggedIn === true; } catch { claude = false; }
  }
  cache = { at: Date.now(), value: { claude, claudeInstalled: !!claudePath, opencode: !!opencodePath } };
  return cache.value;
}

// Free models tried in order for wording. A model without quota answers with an error and the next one is tried.
const OPENCODE_WORDING = ['opencode/deepseek-v4.1-flash-free', 'opencode/glm-5.3-flash-free', 'opencode/minimax-m3.1-flash-free', 'opencode/nemotron-3.5-lightning-free', 'opencode/mimo-v2.6-flash-free'];

/** Ask a model for text. Returns { text, cost, via } or null when no model is available. */
export async function ask(prompt, { cwd, timeout = 3 * 60_000, model } = {}) {
  const have = await clis();
  if (have.claude) {
    const c = readOnly('claude', ['-p', prompt, '--model', model || 'sonnet', '--output-format', 'json', '--disallowedTools', 'Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,Task,NotebookEdit']);
    const r = await run(c.cmd, c.args, { cwd: c.dir, timeout, env: agentEnv() });
    try {
      const j = JSON.parse(r.stdout);
      if (!j.is_error && j.result) return { text: j.result, cost: j.total_cost_usd ?? null, via: 'claude' };
    } catch { /* fall through to opencode */ }
  }
  if (have.opencode) {
    for (const m of OPENCODE_WORDING) {
      const c = readOnly('opencode', ['run', '--standalone', '--agent', 'plan', '-m', m, prompt]);
      const r = await run(c.cmd, c.args, { cwd: c.dir, timeout, env: agentEnv() });
      const text = r.stdout.replace(/\x1b\[[0-9;]*m/g, '').split('\n').filter((l) => !/^\s*>\s*\w+ · /.test(l)).join('\n').trim();
      if (r.code === 0 && text && !/^\s*Error:/m.test(text)) return { text, cost: null, via: m.split('/')[1] };
    }
  }
  return null;
}
