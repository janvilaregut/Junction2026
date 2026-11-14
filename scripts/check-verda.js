// Small authenticated diagnostic; never prints credentials or sends repository code.
import fs from 'node:fs';
import path from 'node:path';
import { DATA, writeJSON } from '../server/util.js';

const base = (process.env.KATSE_VERDA_URL || 'https://containers.datacrunch.io/nemotron-3-5-super-vl-b300/v1').replace(/\/+$/, '');
const model = process.env.KATSE_VERDA_MODEL || 'nemotron-3.5-super-vl';
const timeout = Number(process.argv.find(a=>a.startsWith('--timeout='))?.split('=')[1] || 12000);
if (!Number.isFinite(timeout) || timeout < 1000 || timeout > 90000) throw new Error('timeout must be 1000–90000 ms');
const key = process.env.VERDA_INFERENCE_KEY;
const report = { at:new Date().toISOString(), endpoint:base, model, credentialPresent:!!key, timeoutMs:timeout, probes:[] };
if (key) for (const kind of ['catalogue', 'inference']) {
  const start = Date.now();
  try {
    const r = await fetch(base + (kind === 'catalogue' ? '/models' : '/chat/completions'), {
      method:kind === 'catalogue' ? 'GET' : 'POST', headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},
      ...(kind === 'inference' ? {body:JSON.stringify({model,messages:[{role:'user',content:'Return exactly {"ok":true}.'}],max_tokens:32,chat_template_kwargs:{enable_thinking:false}})} : {}),
      signal:AbortSignal.timeout(timeout),
    });
    let body; try { body = await r.json(); } catch {}
    report.probes.push({kind,status:r.status,ms:Date.now()-start,ok:r.ok && (kind === 'catalogue' ? body?.data?.some(m=>m.id===model) === true : /"ok"\s*:\s*true/.test(body?.choices?.[0]?.message?.content || '')), ...(kind === 'inference' && body?.usage ? {usage:body.usage} : {})});
  } catch(e) { report.probes.push({kind,ok:false,error:e.name === 'TimeoutError' ? 'timeout-without-http-response' : 'network-error',ms:Date.now()-start}); }
}
report.ok = report.probes.length === 2 && report.probes.every(p=>p.ok);
const dir = path.join(DATA,'diagnostics'); fs.mkdirSync(dir,{recursive:true});
const artifact = path.join(dir,`verda-${Date.now()}.json`); writeJSON(artifact,report);
console.log(JSON.stringify({...report,artifact},null,2));
if (!report.ok) process.exitCode = 1;
