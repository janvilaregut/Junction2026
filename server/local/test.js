// Live tests against the local model (oMLX + Gemma 4). Run: npm run local:test
// Tests that need the model are skipped when oMLX is not running.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertLocal, askLocal, chat, health, LOCAL_MODEL, parseJson, runTools } from './omlx.js';
import { scanCode } from './tasks.js';
import { startDemo } from './demo.js';

const h = await health();
const live = h.ok && h.available ? false : `oMLX not available: ${h.error || `${LOCAL_MODEL} not served`}`;

test('refuses to send data anywhere but this machine', () => {
  for (const u of ['http://127.0.0.1:8000/v1', 'http://localhost:8000/v1', 'http://[::1]:8000/v1']) assert.doesNotThrow(() => assertLocal(u));
  for (const u of ['https://api.openai.com/v1', 'http://192.168.0.20:8000/v1', 'http://localhost.evil.com/v1']) {
    assert.throws(() => assertLocal(u), (e) => e.code === 'remote');
  }
});

test('parses JSON wrapped in fences or text', () => {
  assert.deepEqual(parseJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJson('Sure: {"a":{"b":2}} done'), { a: { b: 2 } });
});

test('oMLX is up and serves Gemma 4', { skip: live }, () => {
  assert.equal(h.ok, true);
  assert.ok(h.models.includes(LOCAL_MODEL));
});

test('answers a plain question', { skip: live }, async () => {
  const r = await chat({ prompt: 'What is 17 + 25? Answer with the number only.', temperature: 0, maxTokens: 20 });
  assert.match(r.text, /\b42\b/);
  assert.equal(r.finish, 'stop');
});

test('streams token by token and the pieces add up to the answer', { skip: live }, async () => {
  const chunks = [];
  const r = await chat({ prompt: 'Count from 1 to 30 separated by spaces, nothing else.', temperature: 0, maxTokens: 120, onToken: (t) => chunks.push(t) });
  assert.ok(chunks.length > 1, `expected several chunks, got ${chunks.length}`);
  assert.equal(chunks.join(''), r.text);
  assert.match(r.text, /\b1\b.*\b30\b/s);
  assert.ok(r.usage?.completion_tokens > 0, 'usage arrives at the end of the stream');
});

test('follows a JSON schema', { skip: live }, async () => {
  const r = await chat({
    prompt: 'Is this line a hardcoded secret? const token = "ghp_9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a";',
    schema: { type: 'object', properties: { secret: { type: 'boolean' }, type: { type: 'string' } }, required: ['secret', 'type'] },
    temperature: 0,
    maxTokens: 120,
  });
  assert.equal(r.data.secret, true);
  assert.equal(typeof r.data.type, 'string');
});

test('calls a tool that runs locally and uses its result', { skip: live }, async () => {
  const lookups = [];
  const r = await runTools({
    prompt: 'What is the CVSS base score of CVE-2021-44228 according to the internal database? Use the tool.',
    tools: [{
      name: 'lookup_cve',
      description: 'Look up a CVE in the internal vulnerability database',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      run: async ({ id }) => {
        lookups.push(id);
        return { id, cvss: 7.3, note: 'internal re-score' }; // deliberately not the public 10.0
      },
    }],
    temperature: 0,
    maxTokens: 200,
  });
  assert.deepEqual(lookups, ['CVE-2021-44228']);
  assert.match(r.text, /7\.3/);
});

test('scans code for secrets and injection without repeating the secret', { skip: live }, async () => {
  const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
  const r = await scanCode([
    `const AWS_SECRET_ACCESS_KEY = "${secret}";`,
    'app.get("/u", (req, res) => db.query("SELECT * FROM users WHERE id = " + req.query.id, (e, rows) => res.json(rows)));',
  ].join('\n'));
  assert.equal(r.verdict, 'block');
  const kinds = r.findings.map((f) => f.kind);
  assert.ok(kinds.includes('secret'), `kinds: ${kinds}`);
  assert.ok(kinds.includes('injection'), `kinds: ${kinds}`);
  assert.ok(!JSON.stringify(r).includes(secret), 'the secret must not appear in the result');
});

test('finds nothing in safe code', { skip: live }, async () => {
  const r = await scanCode('export const add = (a, b) => a + b;');
  assert.equal(r.verdict, 'clean');
  assert.equal(r.findings.length, 0);
});

test('askLocal has the same shape as ask() in server/llm.js', { skip: live }, async () => {
  const r = await askLocal('Reply with the single word: ready');
  assert.equal(typeof r.text, 'string');
  assert.match(r.text, /ready/i);
  assert.equal(r.cost, 0);
  assert.equal(r.via, `local:${LOCAL_MODEL}`);
});

test('demo server: health, chat stream and scan over HTTP', { skip: live }, async () => {
  const server = await startDemo({ port: 0 });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const hh = await (await fetch(`${base}/api/local/health`)).json();
    assert.equal(hh.ok, true);

    const res = await fetch(`${base}/api/local/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'Say OK.' }] }) });
    assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    const sse = await res.text();
    assert.match(sse, /event: token/);
    assert.match(sse, /event: done/);

    const bad = await fetch(`${base}/api/local/scan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(bad.status, 400);

    const scan = await (await fetch(`${base}/api/local/scan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'eval(req.query.code)' }) })).json();
    assert.ok(['block', 'review'].includes(scan.verdict));
    assert.ok(scan.findings.length >= 1);
  } finally {
    server.close();
  }
});
