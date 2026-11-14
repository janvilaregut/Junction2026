// Local model client: Gemma 4 served by oMLX (OpenAI-compatible API) on this Mac.
// For work whose data must not leave the machine: private code, security findings, secrets, logs.
// The base URL has to be loopback unless OMLX_ALLOW_REMOTE=1, so a wrong env var cannot quietly send
// that data somewhere else.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from '../util.js';

export const LOCAL_URL = (process.env.OMLX_URL || 'http://127.0.0.1:8000/v1').replace(/\/+$/, '');
export const LOCAL_MODEL = process.env.KATSE_LOCAL_MODEL || 'gemma-4-26B-A4B-it-oQ4e-mtp';

export class LocalModelError extends Error {
  /** code: 'offline' | 'auth' | 'http' | 'timeout' | 'remote' | 'loop' */
  constructor(message, code, cause) {
    super(message, { cause });
    this.name = 'LocalModelError';
    this.code = code;
  }
}

/** Throws unless `url` points at this machine. */
export function assertLocal(url = LOCAL_URL) {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || /^127\./.test(host)) return;
  if (process.env.OMLX_ALLOW_REMOTE === '1') return;
  throw new LocalModelError(`Refusing to send local-only data to ${host}: OMLX_URL must point at this machine (OMLX_ALLOW_REMOTE=1 overrides)`, 'remote');
}

/**
 * OMLX_API_KEY from the environment, this checkout's .env or the main checkout's .env (worktrees share it),
 * and finally oMLX's own settings file. The key is never copied into the repository.
 */
function loadKey() {
  if (process.env.OMLX_API_KEY) return process.env.OMLX_API_KEY.trim();
  const dirs = [ROOT];
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    dirs.push(path.dirname(common));
  } catch { /* not a git checkout */ }
  for (const d of dirs) {
    try {
      const m = fs.readFileSync(path.join(d, '.env'), 'utf8').match(/^\s*OMLX_API_KEY\s*=\s*"?([^"\n]+)"?/m);
      if (m) return m[1].trim();
    } catch { /* no .env here */ }
  }
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.omlx', 'settings.json'), 'utf8')).auth?.api_key || null;
  } catch {
    return null;
  }
}

/** One HTTP call to oMLX. Returns { res, done }; call done() once the body has been read. */
async function request(pathname, { method = 'GET', body, signal, timeout = 5 * 60_000 } = {}) {
  assertLocal();
  const key = loadKey();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new LocalModelError(`oMLX did not answer within ${Math.round(timeout / 1000)} s`, 'timeout')), timeout);
  const onAbort = () => ctrl.abort(signal.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };

  let res;
  try {
    res = await fetch(LOCAL_URL + pathname, {
      method,
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    done();
    if (signal?.aborted) throw signal.reason ?? e;
    if (ctrl.signal.reason instanceof LocalModelError) throw ctrl.signal.reason;
    throw new LocalModelError(`oMLX is not reachable at ${LOCAL_URL}. Open oMLX.app or run \`omlx start\`.`, 'offline', e);
  }
  if (res.status === 401 || res.status === 403) {
    done();
    throw new LocalModelError('oMLX rejected the API key. Put it in .env as OMLX_API_KEY (oMLX → Settings → API key).', 'auth');
  }
  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    done();
    throw new LocalModelError(`oMLX ${res.status}: ${raw.slice(0, 300)}`, 'http');
  }
  return { res, done };
}

/** Model ids oMLX can serve right now. */
export async function models({ signal } = {}) {
  const { res, done } = await request('/models', { signal, timeout: 10_000 });
  try {
    return (await res.json()).data.map((m) => m.id);
  } finally {
    done();
  }
}

/** { ok, url, model, available, models } or { ok: false, url, model, code, error }. Never throws. */
export async function health() {
  try {
    const list = await models();
    return { ok: true, url: LOCAL_URL, model: LOCAL_MODEL, available: list.includes(LOCAL_MODEL), models: list };
  } catch (e) {
    return { ok: false, url: LOCAL_URL, model: LOCAL_MODEL, code: e.code || 'error', error: e.message };
  }
}

/** Tools use the same shape as Gemini's functionDeclarations ({ name, description, parameters }). */
const toOpenAiTool = ({ name, description, parameters }) => ({ type: 'function', function: { name, description, parameters } });

function safeJson(s) {
  if (typeof s !== 'string') return s ?? {};
  try { return JSON.parse(s); } catch { return { _raw: s }; }
}

/** JSON from a model answer, tolerating ```json fences and text around the object. */
export function parseJson(text) {
  const t = String(text).replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '').trim();
  try { return JSON.parse(t); } catch { /* look for the outermost object */ }
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
  throw new SyntaxError(`Model answer is not JSON: ${t.slice(0, 120)}`);
}

function shape(message, finish, usage) {
  const raw = message.tool_calls?.length ? message.tool_calls : [];
  const assistant = { role: 'assistant', content: message.content || null };
  if (raw.length) assistant.tool_calls = raw;
  return {
    text: message.content || '',
    toolCalls: raw.map((c) => ({ id: c.id, name: c.function.name, args: safeJson(c.function.arguments) })),
    finish,
    usage: usage || null,
    tps: usage?.generation_tokens_per_second ?? null,
    message: assistant, // append this to the conversation before the tool results
  };
}

async function readStream(res, onToken) {
  const dec = new TextDecoder();
  let buf = '';
  let text = '';
  let finish = null;
  let usage = null;
  const calls = [];
  const take = (line) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let ev;
    try { ev = JSON.parse(data); } catch { return; }
    if (ev.usage) usage = ev.usage;
    const c = ev.choices?.[0];
    if (!c) return;
    const d = c.delta || {};
    if (d.content) {
      text += d.content;
      onToken(d.content);
    }
    for (const tc of d.tool_calls || []) {
      const slot = (calls[tc.index ?? calls.length] ||= { id: '', type: 'function', function: { name: '', arguments: '' } });
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.function.name += tc.function.name;
      if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
    }
    if (c.finish_reason) finish = c.finish_reason;
  };
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      take(buf.slice(0, i).trim());
      buf = buf.slice(i + 1);
    }
  }
  take(buf.trim());
  return shape({ content: text, tool_calls: calls.filter(Boolean) }, finish, usage);
}

/**
 * One chat completion.
 *   prompt / messages / system   the conversation (prompt is appended as the last user turn)
 *   schema                       JSON Schema the answer must follow; parsed into `data`
 *   json                         free-form JSON object; parsed into `data`
 *   tools                        [{ name, description, parameters }]; calls come back in `toolCalls`
 *   onToken(chunk)               stream the answer token by token
 * Returns { text, data?, toolCalls, finish, usage, tps, ms, model, message }.
 */
export async function chat({
  prompt, messages = [], system, model = LOCAL_MODEL, temperature = 0.2, maxTokens = 2048,
  schema, json = false, tools, toolChoice, onToken, signal, timeout,
} = {}) {
  const msgs = [
    ...(system ? [{ role: 'system', content: system }] : []),
    ...messages,
    ...(prompt ? [{ role: 'user', content: prompt }] : []),
  ];
  const body = { model, messages: msgs, temperature, max_tokens: maxTokens };
  if (schema) body.response_format = { type: 'json_schema', json_schema: { name: 'answer', schema, strict: true } };
  else if (json) body.response_format = { type: 'json_object' };
  if (tools?.length) {
    body.tools = tools.map(toOpenAiTool);
    if (toolChoice) body.tool_choice = toolChoice;
  }
  const stream = typeof onToken === 'function';
  if (stream) Object.assign(body, { stream: true, stream_options: { include_usage: true } });

  const started = Date.now();
  const { res, done } = await request('/chat/completions', { method: 'POST', body, signal, timeout });
  try {
    let out;
    if (stream) {
      out = await readStream(res, onToken);
    } else {
      const j = await res.json();
      const c = j.choices?.[0] || {};
      out = shape(c.message || {}, c.finish_reason ?? null, j.usage);
    }
    if ((schema || json) && !out.toolCalls.length) out.data = parseJson(out.text);
    return { ...out, ms: Date.now() - started, model };
  } finally {
    done();
  }
}

/**
 * Agent loop with tools that run here, in this process: the model asks, the tool runs locally, the result
 * goes back, until the model answers in text. tools: [{ name, description, parameters, run: async (args) => any }].
 * Returns the final chat() result plus `trace` ([{ name, args, result }]) and the full `messages`.
 */
export async function runTools({ prompt, messages = [], tools, maxSteps = 6, ...opts }) {
  const convo = [...messages, ...(prompt ? [{ role: 'user', content: prompt }] : [])];
  const trace = [];
  for (let step = 0; step < maxSteps; step++) {
    const r = await chat({ ...opts, messages: convo, tools });
    if (!r.toolCalls.length) return { ...r, trace, messages: convo };
    convo.push(r.message);
    for (const call of r.toolCalls) {
      const tool = tools.find((t) => t.name === call.name);
      let result;
      try {
        result = tool ? await tool.run(call.args) : { error: `unknown tool ${call.name}` };
      } catch (e) {
        result = { error: e.message };
      }
      trace.push({ name: call.name, args: call.args, result });
      convo.push({ role: 'tool', tool_call_id: call.id, content: typeof result === 'string' ? result : JSON.stringify(result) });
    }
  }
  throw new LocalModelError(`Tool loop did not finish in ${maxSteps} steps`, 'loop');
}

/**
 * Same contract as ask() in server/llm.js ({ text, cost, via } or null when no model is available), so a
 * caller can switch to the local model without other changes.
 */
export async function askLocal(prompt, { model = LOCAL_MODEL, system, timeout, signal } = {}) {
  try {
    const r = await chat({ prompt, system, model, timeout, signal, maxTokens: 4096 });
    return { text: r.text.trim(), cost: 0, via: `local:${model}` };
  } catch (e) {
    if (e.code === 'offline' || e.code === 'auth') return null;
    throw e;
  }
}
