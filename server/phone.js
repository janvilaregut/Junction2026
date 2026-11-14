// The phone as a second local worker. Proof of concept.
// When a Pixel is plugged into this Mac's USB the interface plays a ripple, and Katse links to the Gemma that runs
// on the phone's TPU (the android-tpu-server app, reached through `adb forward`, loopback only). The link is a
// capability, not a route: every scan still goes to the Mac's Gemma unless KATSE_GEMMA_DEVICE=phone.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GOOGLE_VENDOR = 6353; // 0x18D1: Pixel, and the adb interface of most Android phones
const PORT = Number(process.env.KATSE_PHONE_PORT) || 8090;
const MODEL_ON_PHONE = process.env.KATSE_PHONE_MODEL_PATH || '/data/local/tmp/gemma4/model.litertlm';
export const PHONE_GEMMA = { url: `http://127.0.0.1:${PORT}/v1`, model: 'gemma-4-E2B-pixel-npu' };

const ADB = [process.env.ANDROID_HOME && path.join(process.env.ANDROID_HOME, 'platform-tools', 'adb'), path.join(os.homedir(), 'Library/Android/sdk/platform-tools/adb')].find((p) => p && fs.existsSync(p)) || 'adb';
const sh = (cmd, args, timeout = 4000) => new Promise((resolve) => execFile(cmd, args, { timeout, maxBuffer: 8e6 }, (err, stdout) => resolve(err ? null : String(stdout))));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// gemma: 'off' (no phone) | 'connecting' | 'ready' (the phone's model answers) | 'standby' (phone here, model not up)
const state = { connected: false, name: null, gemma: 'off' };
const subs = new Set();
let epoch = 0, misses = 0, timer = null;

const usingPhone = () => process.env.KATSE_GEMMA_DEVICE === 'phone' && state.gemma === 'ready';
export const phoneState = () => ({ connected: state.connected, name: state.name, gemma: { state: state.gemma, ...PHONE_GEMMA }, using: usingPhone() ? 'phone' : 'mac' });
/** Extra PrivacyGateway options: empty (the Mac's Gemma) unless the phone was asked for and its model is up. */
export const gemmaTarget = () => (usingPhone() ? { ...PHONE_GEMMA } : {});
const emit = (type) => { const e = { type, ...phoneState() }; for (const fn of subs) fn(e); };

/** The plugged phone's product name, or null when there is none. */
async function plugged() {
  if (process.platform !== 'darwin') return null;
  const out = await sh('ioreg', ['-p', 'IOUSB', '-l', '-w0']);
  if (!out) return null;
  const dev = out.split('+-o ').find((b) => b.includes(`"idVendor" = ${GOOGLE_VENDOR}`));
  return dev ? dev.match(/"USB Product Name" = "([^"]+)"/)?.[1] || 'Phone' : null;
}

const health = () => fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(1500) }).then((r) => r.json()).then((j) => j.status || null).catch(() => null);

/** Forward the phone's Gemma port to loopback and wait for the model. Best effort: no app or no adb leaves 'standby'. */
async function link(mine) {
  const live = () => mine === epoch && state.connected;
  state.gemma = 'connecting'; emit('gemma');
  let ready = false;
  for (let i = 0; i < 14 && live() && !ready; i++) {
    await sh(ADB, ['forward', `tcp:${PORT}`, `tcp:${PORT}`]); // fails until the phone has authorised this Mac
    const status = await health();
    ready = status === 'ready';
    // Nothing listening on the phone: start the server app, the way scripts/start_pixel_tpu.sh does. It only loads the model.
    if (!status && i === 1 && process.env.KATSE_PHONE_START !== 'off') await sh(ADB, ['shell', 'am', 'start-foreground-service', '-n', 'dev.accelgemma.tpuserver/.ServerService', '--es', 'model', MODEL_ON_PHONE, '--es', 'backend', 'npu', '--ei', 'port', String(PORT)], 8000);
    if (!ready) await sleep(1500);
  }
  if (!live()) return;
  state.gemma = ready ? 'ready' : 'standby'; emit('gemma');
  console.log(`[phone] ${state.name}: Gemma ${state.gemma}${ready ? ` at ${PHONE_GEMMA.url}` : ''}; scans use the ${usingPhone() ? 'phone' : 'Mac'}`);
}

function connect(name, real = true) {
  state.connected = true; state.name = name; misses = 0;
  const mine = ++epoch;
  emit('connect');
  if (real) link(mine).catch(() => {});
}
function disconnect() {
  state.connected = false; state.name = null; state.gemma = 'off'; epoch++;
  emit('disconnect');
}

async function poll() {
  const name = await plugged().catch(() => null);
  if (name && !state.connected) connect(name);
  // A Pixel re-enumerates right after it is plugged (USB mode switch): one missed poll is not an unplug.
  else if (!name && state.connected && !state.simulated && ++misses >= 3) disconnect();
  else if (name) misses = 0;
  timer = subs.size ? setTimeout(poll, 500) : null;
}

/** Listen for plug, unplug and link changes. USB is only polled while someone listens. Returns the unsubscribe. */
export function subscribePhone(fn) {
  subs.add(fn);
  if (!timer) timer = setTimeout(poll, 0);
  return () => subs.delete(fn);
}

/** Rehearse the plug without the phone: the same events, no adb. It unplugs itself after a few seconds. */
export function simulatePhone() {
  if (state.connected) return phoneState();
  state.simulated = true;
  connect('Pixel (simulated)', false);
  state.gemma = 'standby'; emit('gemma');
  setTimeout(() => { state.simulated = false; if (state.connected) disconnect(); }, 9000);
  return phoneState();
}
