#!/usr/bin/env node
/* FPS bench for the Katse UI. Drives a headless Chromium over the DevTools protocol through the scenes
   that move (the branch tree, opening a branch, the graph, Fix it, the commit rail) and reports, per scene,
   the frame rate and where each frame's time goes: script, style, layout, paint on the main thread,
   raster on the worker threads, and the GPU process.

   Usage:  node tools/fps-bench.mjs [url] [--out results.json] [--label name] [--only scene,scene]
   Needs a Chromium: CHROME=/path/to/chrome, or the Playwright one in ~/Library/Caches/ms-playwright. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : d; };
const JS = opt('--eval', ''), CSS = opt('--css', ''), OUT = opt('--out', null), LABEL = opt('--label', 'run'), ONLY = opt('--only', '');
const NOGPU = args.includes('--nogpu') && !!args.splice(args.indexOf('--nogpu'), 1);
const CPU = +opt('--cpu', 1), UNLIMITED = args.includes('--unlimited') && !!args.splice(args.indexOf('--unlimited'), 1);
const W = +opt('--w', 1728), H = +opt('--h', 1117), DPR = +opt('--dpr', 2);
const URL0 = args[0] || 'http://localhost:4177/';

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const pw = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  for (const d of fs.existsSync(pw) ? fs.readdirSync(pw).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse() : []) {
    const p = path.join(pw, d, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
    if (fs.existsSync(p)) return p;
  }
  for (const p of ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome']) if (fs.existsSync(p)) return p;
  throw new Error('No Chromium found: set CHROME=/path/to/chrome');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 9300 + Math.floor(Math.random() * 600);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'katse-bench-'));
const chrome = spawn(findChrome(), [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `--window-size=${W},${H}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio', '--ignore-gpu-blocklist',
  ...(NOGPU ? ['--disable-gpu', '--disable-gpu-compositing', '--disable-software-rasterizer'] : ['--enable-gpu', '--use-angle=metal']), '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  ...(UNLIMITED ? ['--disable-frame-rate-limit', '--disable-gpu-vsync'] : []), 'about:blank',
], { stdio: 'ignore' });
const cleanup = () => { try { chrome.kill('SIGKILL'); } catch { /* gone */ } try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* busy */ } };
process.on('exit', cleanup);

async function target() {
  for (let i = 0; i < 100; i++) {
    try { const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const p = list.find((t) => t.type === 'page'); if (p) return p.webSocketDebuggerUrl; } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error('Chromium did not start');
}
function connect(url) {
  const ws = new WebSocket(url); let id = 0; const pending = new Map(), subs = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.rej(new Error(`${p.method}: ${msg.error.message}`)) : p.res(msg.result); }
    else (subs.get(msg.method) || []).forEach((f) => f(msg.params));
  };
  return new Promise((ok) => (ws.onopen = () => ok({
    send: (method, params = {}) => new Promise((res, rej) => { pending.set(++id, { res, rej, method }); ws.send(JSON.stringify({ id, method, params })); }),
    on: (m, f) => subs.set(m, [...(subs.get(m) || []), f]),
    off: (m) => subs.delete(m),
    close: () => ws.close(),
  })));
}

const c = await connect(await target());
const evaluate = async (expr) => { const r = await c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
const mouse = (type, x, y, extra = {}) => c.send('Input.dispatchMouseEvent', { type, x, y, button: extra.button || 'none', buttons: extra.buttons || 0, clickCount: extra.clickCount || 0 });
const click = async (x, y) => { await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y, { button: 'left', buttons: 1, clickCount: 1 }); await mouse('mouseReleased', x, y, { button: 'left', clickCount: 1 }); };
const key = async (k) => { await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: k === 'Escape' ? 27 : k.toUpperCase().charCodeAt(0) }); await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k }); };

await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('Performance.enable');
await c.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: DPR, mobile: false });
if (CPU > 1) await c.send('Emulation.setCPUThrottlingRate', { rate: CPU });
/* In the page: a rAF clock for the frame rate, and the long animation frames (>50 ms) with what caused them. */
await c.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__fps={t:[],loaf:[],on:false,
  start(){this.t=[];this.loaf=[];this.on=true;const f=(n)=>{if(!this.on)return;this.t.push(n);requestAnimationFrame(f)};requestAnimationFrame(f)},
  stop(){this.on=false;return{t:this.t,loaf:this.loaf}}};
  try{new PerformanceObserver((l)=>{if(!__fps.on)return;for(const e of l.getEntries())__fps.loaf.push({d:Math.round(e.duration),block:Math.round(e.blockingDuration),render:Math.round(e.renderStart?e.startTime+e.duration-e.renderStart:0),style:Math.round(e.styleAndLayoutStart?e.startTime+e.duration-e.styleAndLayoutStart:0),
    scripts:e.scripts.map((s)=>({d:Math.round(s.duration),forced:Math.round(s.forcedStyleAndLayoutDuration),fn:s.sourceFunctionName||s.invoker,src:(s.sourceURL||'').split('/').pop()+':'+s.sourceCharPosition}))})}).observe({type:'long-animation-frame',buffered:false})}catch{}` });
const gpu = await c.send('SystemInfo.getInfo').catch(() => null);
await c.send('Page.navigate', { url: URL0 });
for (let i = 0; i < 100 && !(await evaluate(`!!document.querySelector('#tree .lane')`).catch(() => false)); i++) await sleep(100);
if (CSS) await evaluate(`document.head.insertAdjacentHTML('beforeend', ${JSON.stringify(`<style>${CSS}</style>`)})`);
if (JS) await evaluate(JS);
await sleep(1500); // fonts, first paint, the mascot settling

/* ── Trace: where the time goes ── */
const CATS = 'toplevel,devtools.timeline,disabled-by-default-devtools.timeline,viz,gpu';
async function traced(fn) {
  const events = []; c.on('Tracing.dataCollected', (p) => events.push(...p.value));
  const done = new Promise((r) => c.on('Tracing.tracingComplete', r));
  await c.send('Tracing.start', { categories: CATS, transferMode: 'ReportEvents' });
  const out = await fn();
  await c.send('Tracing.end'); await done;
  c.off('Tracing.dataCollected'); c.off('Tracing.tracingComplete');
  return { out, events };
}
function analyse(events, frames, ms) {
  const names = new Map();
  for (const e of events) if (e.ph === 'M' && e.name === 'thread_name') names.set(`${e.pid}:${e.tid}`, e.args.name);
  const main = [...names].find(([k, v]) => v === 'CrRendererMain' && events.some((e) => `${e.pid}:${e.tid}` === k && (e.name === 'UpdateLayoutTree' || e.name === 'Paint')))?.[0]
    || [...names].find(([, v]) => v === 'CrRendererMain')?.[0];
  const busy = {}, blink = {}, stack = new Map(); let paints = 0, t0 = Infinity, t1 = 0;
  for (const e of events.filter((x) => x.ph === 'X' && x.dur != null).sort((a, b) => a.ts - b.ts)) {
    const k = `${e.pid}:${e.tid}`, tname = names.get(k) || '?';
    t0 = Math.min(t0, e.ts); t1 = Math.max(t1, e.ts + e.dur);
    if (/RunTask/.test(e.name) && e.cat.includes('toplevel')) {
      const end = stack.get(k) || 0; if (e.ts >= end) { stack.set(k, e.ts + e.dur); const g = group(tname, k === main); busy[g] = (busy[g] || 0) + e.dur / 1000; }
    }
    if (k === main) {
      const b = { FireAnimationFrame: 'script', FunctionCall: 'script', EventDispatch: 'script', TimerFire: 'script', EvaluateScript: 'script', UpdateLayoutTree: 'style', Layout: 'layout', PrePaint: 'paint', Paint: 'paint', Layerize: 'layerize' }[e.name];
      if (b) blink[b] = (blink[b] || 0) + e.dur / 1000;
      if (e.name === 'Paint' || e.name === 'PrePaint') paints += e.name === 'PrePaint' ? 1 : 0;
    }
  }
  const secs = ms / 1000;
  const d = frames.slice(1).map((t, i) => t - frames[i]).sort((a, b) => a - b), n = d.length;
  const r1 = (x) => Math.round(x * 10) / 10, r0 = (x) => Math.round(x);
  const per = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, r0(v / secs)]));
  return {
    fps: n ? r1((n / (frames.at(-1) - frames[0])) * 1000) : null, p95: n ? r1(d[Math.floor(n * 0.95)]) : null, worst: n ? r1(d.at(-1)) : null, janky: n ? Math.round((d.filter((x) => x > 25).length / n) * 100) : null,
    framesPerSec: r0(paints / secs), threadMsPerSec: per(busy), mainMsPerSec: per(blink),
  };
}
function group(t, isMain) {
  if (isMain) return 'main';
  if (/CrRendererMain/.test(t)) return 'otherRenderer';
  if (/Compositor$/.test(t)) return 'compositor';
  if (/TileWorker|Raster/.test(t)) return 'raster';
  if (/CrGpuMain|GpuMain/.test(t)) return 'gpu';
  if (/Viz/.test(t)) return 'viz';
  return 'other';
}

/* ── Scenes ── */
const results = {};
async function scene(name, ms, act = async () => {}, { probe = true } = {}) {
  if (ONLY && !ONLY.split(',').includes(name)) return;
  const { events, out } = await traced(async () => {
    if (probe) await evaluate('__fps.start()'); else await evaluate('__fps.loaf = []; __fps.on = true; 0');
    const t0 = Date.now(); const r = await act(); const left = ms - (Date.now() - t0); if (left > 0) await sleep(left);
    const s = await evaluate(probe ? '__fps.stop()' : '(__fps.on = false, { t: [], loaf: __fps.loaf })');
    return { frames: s.t.slice(1), loaf: s.loaf, r }; // the first interval straddles the trace start
  });
  if (process.env.DUMP === name) fs.writeFileSync(process.env.DUMP_FILE || `trace-${name}.json`, JSON.stringify({ traceEvents: events }));
  const a = analyse(events, out.frames, ms);
  a.loaf = out.loaf.sort((x, y) => y.d - x.d).slice(0, 4);
  results[name] = a;
  const t = a.threadMsPerSec, b = a.mainMsPerSec, f = (x, w) => String(x ?? '–').padStart(w);
  console.log(`${name.padEnd(14)} ${f(a.fps, 5)} fps  p95 ${f(a.p95, 5)}  worst ${f(a.worst, 6)}  jank ${f(a.janky, 3)}%  frames/s ${f(a.framesPerSec, 3)} | ms per second → main ${f(t.main ?? 0, 4)} (js ${b.script ?? 0} style ${b.style ?? 0} layout ${b.layout ?? 0} paint ${b.paint ?? 0})  gpu ${f(t.gpu ?? 0, 4)}  viz ${f(t.viz ?? 0, 4)}  raster ${t.raster ?? 0}`);
  if (process.env.LOAF) for (const l of a.loaf) console.log(`    long frame ${l.d}ms (render ${l.render}, style+layout ${l.style}) ← ${l.scripts.filter((s) => s.d > 3).map((s) => `${s.fn} ${s.src} ${s.d}ms${s.forced ? ` (forced layout ${s.forced}ms)` : ''}`).join(' · ') || 'no script'}`);
}
const rect = (sel) => evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
const tips = () => evaluate(`[...document.querySelectorAll('#tree .lane')].map((g) => tipOf(g.dataset.pr)).filter(Boolean)`);

console.log(`Katse FPS bench · ${LABEL} · ${URL0} · ${W}x${H}@${DPR}x · GPU: ${gpu?.gpu?.devices?.[0]?.deviceString || '?'} ${gpu?.gpu?.featureStatus?.gpu_compositing || ''} raster:${gpu?.gpu?.featureStatus?.rasterization || ''}`);
await mouse('mouseMoved', 20, 20);
await scene('home-idle', 3000, undefined, { probe: false });
await scene('home-hover', 4000, async () => {
  const pts = await tips(); if (!pts.length) return;
  const path = pts.flatMap(([x, y]) => [[x, y], [x, y + 40]]);
  for (let i = 0; i < 230; i++) { const [x, y] = path[Math.floor(i / 8) % path.length]; await mouse('mouseMoved', x + (i % 8) * 3, y); await sleep(16); }
});
await scene('home-older', 2500, async () => { const b = await rect('#more'); if (b) await click(...b); await sleep(300); const pts = await tips(); for (let i = 0; i < 100; i++) { const [x, y] = pts[i % pts.length]; await mouse('mouseMoved', x, y); await sleep(16); } });
await evaluate(`S.expanded = false; renderTree()`); await mouse('mouseMoved', 20, 20); await sleep(400);
await scene('rail-unfold', 2200, async () => { await evaluate(`showCommits(S.prs.incoming.find((p) => p.last)?.id)`); });
await evaluate(`hideCommits()`); await sleep(900);
const verified = await evaluate(`(S.prs.incoming.find((p) => p.last && /2129/.test(p.id)) || S.prs.incoming.find((p) => p.last) || S.prs.incoming[0]).id`);
await scene('open-branch', 2500, async () => { const p = await evaluate(`tipOf(${JSON.stringify(verified)})`); if (p) await click(...p); else await evaluate(`openGraph(S.prs.incoming.find((p) => p.id === ${JSON.stringify(verified)}))`); });
await sleep(800);
await scene('graph-idle', 3000, undefined, { probe: false });
await scene('graph-hover', 3000, async () => {
  const pts = await evaluate(`[...G.nodes.values()].map((n) => toScreen(n.bx, n.by))`);
  for (let i = 0; i < 170; i++) { const [x, y] = pts[Math.floor(i / 6) % pts.length]; await mouse('mouseMoved', x, y); await sleep(16); }
});
await scene('graph-focus', 3000, async () => { // a click on a node: the camera flies and zooms to it, then back out
  await evaluate(`focusOn([[...G.nodes.values()].find((n) => n.kind === 'zone' || n.kind === 'file').id])`); await sleep(1500); await evaluate(`zoomGraph('fit')`);
});
await sleep(600);
await scene('graph-pan', 2500, async () => {
  const x0 = 200, y0 = H - 220; await mouse('mouseMoved', x0, y0); await mouse('mousePressed', x0, y0, { button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 0; i < 130; i++) { await mouse('mouseMoved', x0 + Math.sin(i / 12) * 160, y0 - Math.cos(i / 15) * 80, { buttons: 1 }); await sleep(16); }
  await mouse('mouseReleased', x0, y0, { button: 'left', clickCount: 1 });
});
await evaluate(`zoomGraph('fit')`); await sleep(1200);
await scene('fixit-grow', 6000, async () => { const b = await rect('#bFix'); if (b) await click(...b); else await evaluate(`openFixit({})`); });
await scene('fixit-debate', 6000);
await evaluate(`fixSkip()`); await sleep(500);
await scene('fixit-end', 2500, undefined, { probe: false });
await scene('fixit-close', 1500, async () => { await key('Escape'); });
await scene('close-branch', 1800, async () => { await evaluate(`closeGraph()`); });
await scene('home-after', 2500, undefined, { probe: false });

if (OUT) {
  const all = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
  all[LABEL] = { at: new Date().toISOString(), url: URL0, viewport: [W, H, DPR], results };
  fs.writeFileSync(OUT, JSON.stringify(all, null, 2));
}
c.close(); cleanup(); process.exit(0);
