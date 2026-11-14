// Shared helpers: process execution, JSON storage, hashing, paths.
import { spawn } from 'node:child_process';
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execution, remaining, DeadlineError } from './execution.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (fs.existsSync(path.join(ROOT, '.env.local'))) process.loadEnvFile(path.join(ROOT, '.env.local'));
export const DATA = process.env.KATSE_DATA || path.join(ROOT, 'data');
fs.mkdirSync(DATA, { recursive: true });

const DOTNET_HOME = path.join(os.homedir(), '.dotnet');

/** Environment for every child process: adds a user-local .NET install and silences telemetry. */
export function toolEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  const pathName = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'PATH';
  env[pathName] = [process.platform === 'win32' ? 'C:/Program Files/Git/bin' : '', path.join(ROOT, 'node_modules/opencode-ai/bin'), path.join(process.env.LOCALAPPDATA || os.homedir(), 'Katse/tools'), env[pathName] || ''].join(path.delimiter);
  if (fs.existsSync(path.join(DOTNET_HOME, process.platform === 'win32' ? 'dotnet.exe' : 'dotnet'))) {
    env.DOTNET_ROOT = DOTNET_HOME;
    const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'PATH';
    env[pathKey] = `${DOTNET_HOME}${path.delimiter}${env[pathKey] || ''}`;
  }
  env.DOTNET_CLI_TELEMETRY_OPTOUT = '1';
  env.DOTNET_NOLOGO = '1';
  env.DOTNET_SKIP_FIRST_TIME_EXPERIENCE = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

export function runnerEnv() {
  const env = toolEnv();
  for (const key of Object.keys(env)) if (/API_KEY|INFERENCE_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET/i.test(key)) delete env[key];
  return env;
}

/**
 * Run a command without a shell. Resolves with { code, stdout, stderr, ms, timedOut }.
 * Never rejects on a non-zero exit; callers decide what a failure means.
 */
export function run(cmd, args, { cwd, timeout = 10 * 60_000, env, input, onLine } = {}) {
  timeout = remaining(timeout);
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let child;
    try {
      // Many CLIs trust $PWD over the real working directory. A stale value sends them to the parent's folder.
      const childEnv = { ...(env || toolEnv()) };
      if (cwd) { childEnv.PWD = cwd; delete childEnv.OLDPWD; delete childEnv.INIT_CWD; }
      child = spawn(cmd, args, { cwd, env: childEnv, detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: String(e), ms: 0, timedOut: false });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const cap = (s, chunk) => (s.length > 4_000_000 ? s : s + chunk);
    const lines = (chunk) => {
      if (!onLine) return;
      for (const l of chunk.toString().split('\n')) if (l.trim()) onLine(redact(l));
    };
    child.stdout.on('data', (d) => { stdout = cap(stdout, d.toString()); lines(d); });
    child.stderr.on('data', (d) => { stderr = cap(stderr, d.toString()); lines(d); });
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    }, timeout);
    child.on('error', (e) => { stderr += String(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut && execution.getStore() && Date.now() >= execution.getStore().deadline) return reject(new DeadlineError());
      resolve({ code: timedOut ? -2 : code ?? -1, stdout: redact(stdout), stderr: redact(stderr), ms: Date.now() - started, timedOut });
    });
    child.stdin.on('error', () => {});
    if (input) child.stdin.end(input); else child.stdin.end();
  });
}

export function redact(value) {
  let text = String(value);
  for (const key of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'VERDA_INFERENCE_KEY']) {
    if (process.env[key]) text = text.split(process.env[key]).join('[REDACTED]');
  }
  return text;
}

export async function which(cmd) {
  const r = process.platform === 'win32'
    ? await run('where.exe', [cmd], { timeout: 5000 })
    : await run('/bin/sh', ['-c', `command -v ${cmd}`], { timeout: 5000 });
  return r.code === 0 ? r.stdout.trim().split(/\r?\n/)[0] : null;
}

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, redact(JSON.stringify(value, null, 2)));
  // Windows indexers/OneDrive can briefly deny a rename while reading the target.
  // Keep the atomic replace; retry the transient lock instead of truncating the report.
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(tmp, file); break; }
    catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code) || attempt >= 9) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
    }
  }
}

export function appendJSONL(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, redact(JSON.stringify(value)) + '\n');
}

export function readJSONL(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

export const slug = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);

export const tail = (s, n = 4000) => (s.length > n ? '…' + s.slice(-n) : s);
