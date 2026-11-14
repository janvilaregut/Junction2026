/* Screenshots of the same Fix it moments on two builds, to compare the look. Usage: node tools/shots.mjs <url> <outdir> [t1,t2,...] */
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const [URL0, OUT, TS = '2600,4800,7200,9800,12500,16000,99999'] = process.argv.slice(2);
fs.mkdirSync(OUT, { recursive: true });
const pw = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const CH = process.env.CHROME || path.join(pw, fs.readdirSync(pw).filter((x) => /^chromium-\d+$/.test(x)).sort().pop(), 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const port = 9900 + Math.floor(Math.random() * 90), prof = fs.mkdtempSync(path.join(os.tmpdir(), 'katse-shot-'));
const ch = spawn(CH, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, '--window-size=1440,900', '--enable-gpu', '--use-angle=metal', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws; for (let i = 0; i < 50; i++) { try { const l = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const p = l.find((t) => t.type === 'page'); if (p) { ws = p.webSocketDebuggerUrl; break; } } catch {} await sleep(100); }
const sock = new WebSocket(ws); await new Promise((r) => (sock.onopen = r)); let id = 0; const pend = new Map();
sock.onmessage = (m) => { const x = JSON.parse(m.data); if (x.id) { pend.get(x.id)(x); pend.delete(x.id); } };
const send = (method, params = {}) => new Promise((r) => { pend.set(++id, r); sock.send(JSON.stringify({ id, method, params })); });
const ev = async (e) => { const r = (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result; if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description); return r.result?.value; };
await send('Page.enable'); await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
await send('Page.navigate', { url: URL0 }); await sleep(3000);
const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 80 }); fs.writeFileSync(path.join(OUT, name + '.jpg'), Buffer.from(r.result.data, 'base64')); };
await shot('0-home');
await ev(`openGraph(S.prs.incoming.find((p) => p.last && /2129/.test(p.id)) || S.prs.incoming.find((p) => p.last))`); await sleep(3500); await shot('1-graph');
await ev(`openFixit({})`); await sleep(1500); await ev(`fixSkip()`);
for (const t of TS.split(',').map(Number)) { const r = await ev(`fixSeek(${t})`); await sleep(400); await shot(`2-fix-${String(Math.min(t, r.end)).padStart(5, '0')}`); }
sock.close(); ch.kill('SIGKILL'); process.exit(0);
