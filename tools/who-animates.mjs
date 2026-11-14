/* Which loops and CSS animations keep a Katse page busy when nobody touches it. Usage: node tools/who-animates.mjs [url] */
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const URL0 = process.argv[2] || 'http://localhost:4177/';
const pw = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const CH = process.env.CHROME || path.join(pw, fs.readdirSync(pw).filter((x) => /^chromium-\d+$/.test(x)).sort().pop(), 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const port = 9700 + Math.floor(Math.random() * 200), prof = fs.mkdtempSync(path.join(os.tmpdir(), 'katse-who-'));
const ch = spawn(CH, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, '--window-size=1728,1117', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws; for (let i = 0; i < 50; i++) { try { const l = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const p = l.find((t) => t.type === 'page'); if (p) { ws = p.webSocketDebuggerUrl; break; } } catch {} await sleep(100); }
const sock = new WebSocket(ws); await new Promise((r) => (sock.onopen = r)); let id = 0; const pend = new Map();
sock.onmessage = (m) => { const x = JSON.parse(m.data); if (x.id) { pend.get(x.id)(x.result); pend.delete(x.id); } };
const send = (method, params = {}) => new Promise((r) => { pend.set(++id, r); sock.send(JSON.stringify({ id, method, params })); });
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result?.value; };
await send('Page.enable'); await send('Runtime.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__raf = new Map(); const _r = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = (f) => _r((t) => { const k = (f.name || 'anon') + ' ' + (new Error().stack.split('\\n')[2] || '').trim().split('/').pop(); __raf.set(k, (__raf.get(k) || 0) + 1); f(t); });` });
await send('Page.navigate', { url: URL0 }); await sleep(3500);
const probe = async (label) => {
  await ev(`__raf.clear()`); await sleep(2000);
  const r = await ev(`({ raf: [...__raf].map(([k, v]) => k + ' ×' + Math.round(v / 2) + '/s'), anims: document.getAnimations().filter((a) => a.playState === 'running').map((a) => (a.animationName || a.transitionProperty || 'js') + ' on ' + (() => { const t = a.effect && a.effect.target; return t ? (t.id || String(t.className && t.className.baseVal != null ? t.className.baseVal : t.className) || t.tagName) : '?'; })()).reduce((m, k) => (m[k] = (m[k] || 0) + 1, m), {}) })`);
  console.log(`\n== ${label}\n  rAF callbacks: ${r.raf.join(' | ') || 'none'}\n  running CSS animations: ${JSON.stringify(r.anims)}`);
};
await probe('home, idle');
await ev(`openGraph(S.prs.incoming.find((p) => p.last))`); await sleep(5000);
await probe('graph, idle');
await ev(`openFixit({})`); await sleep(1000); await ev(`fixSkip()`); await sleep(1500);
await probe('fix it, ended');
sock.close(); ch.kill('SIGKILL'); process.exit(0);
