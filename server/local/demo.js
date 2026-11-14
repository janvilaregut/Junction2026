// Standalone demo server for the local model. Listens on 127.0.0.1 only.
//   GET  /                   demo page
//   GET  /api/local/health   oMLX status and models
//   POST /api/local/chat     { messages, system? } -> text/event-stream: token {t}, done {text, ms, tps, usage}, error {error}
//   POST /api/local/scan     { code, lang? } -> { verdict, summary, findings, ms, tps, model }
// The same handlers can be mounted in server/index.js later (handleLocal returns false for other paths).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chat, health } from './omlx.js';
import { scanCode } from './tasks.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Body too large (1 MB max)'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(Object.assign(new Error('Body is not JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

const sendJson = (res, status, obj) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
};

/** Aborts when the client goes away, so the model stops generating for nobody. */
function clientSignal(req, res) {
  const ctrl = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ctrl.abort(new Error('client closed')); });
  return ctrl.signal;
}

/** Handles /api/local/*. Returns false when the path is not one of ours. */
export async function handleLocal(req, res, url) {
  if (url.pathname === '/api/local/health' && req.method === 'GET') {
    sendJson(res, 200, await health());
    return true;
  }

  if (url.pathname === '/api/local/chat' && req.method === 'POST') {
    const body = await readBody(req);
    const messages = Array.isArray(body.messages) ? body.messages.filter((m) => ['user', 'assistant'].includes(m?.role) && typeof m.content === 'string') : [];
    if (!messages.length) {
      sendJson(res, 400, { error: 'messages is required' });
      return true;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    try {
      const r = await chat({ messages, system: typeof body.system === 'string' ? body.system : undefined, maxTokens: 4096, signal: clientSignal(req, res), onToken: (t) => send('token', { t }) });
      send('done', { text: r.text, ms: r.ms, tps: r.tps, usage: r.usage, model: r.model });
    } catch (e) {
      if (!res.destroyed) send('error', { error: e.message, code: e.code });
    }
    res.end();
    return true;
  }

  if (url.pathname === '/api/local/scan' && req.method === 'POST') {
    const body = await readBody(req);
    if (typeof body.code !== 'string' || !body.code.trim()) {
      sendJson(res, 400, { error: 'code is required' });
      return true;
    }
    try {
      sendJson(res, 200, await scanCode(body.code, { lang: body.lang, signal: clientSignal(req, res) }));
    } catch (e) {
      if (!res.destroyed) sendJson(res, e.code === 'offline' ? 503 : 500, { error: e.message, code: e.code });
    }
    return true;
  }

  return false;
}

export function startDemo({ port = Number(process.env.PORT) || 4179, host = '127.0.0.1' } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || host}`);
    try {
      if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(fs.readFileSync(path.join(HERE, 'demo.html')));
      }
      if (url.pathname.startsWith('/api/local/') && (await handleLocal(req, res, url))) return;
      sendJson(res, 404, { error: 'not found' });
    } catch (e) {
      if (!res.headersSent) sendJson(res, e.status || 500, { error: e.message });
      else res.end();
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = await startDemo();
  const { port, address } = server.address();
  console.log(`Local model demo on http://${address}:${port}  (oMLX + Gemma 4, nothing leaves this machine)`);
}
