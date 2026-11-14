import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TokenBudget, execution } from '../server/execution.js';
import { resolveProfile } from '../server/profiles.js';
import { session, configuration, attachSession, providerPreflight, clearPreflightCache, models } from '../server/agents.js';
import { run } from '../server/util.js';

const testCredentials = Object.fromEntries(['GEMINI_API_KEY','VERDA_INFERENCE_KEY'].map(k=>[k,process.env[k]]));
before(()=>{ process.env.GEMINI_API_KEY='synthetic-google';process.env.VERDA_INFERENCE_KEY='synthetic-verda'; });
after(()=>{ for(const [key,value] of Object.entries(testCredentials)) if(value===undefined)delete process.env[key];else process.env[key]=value; });

test('profiles have conservative defaults and reject invalid unbounded budgets', () => {
  assert.equal(resolveProfile().id, 'standard');
  assert.equal(resolveProfile().initialCandidates, 2);
  assert.equal(resolveProfile({ profile: 'quick' }).initialCandidates, 0);
  assert.equal(resolveProfile({ profile: 'deep' }).maxDescendants, 2);
  assert.equal(resolveProfile({ budgetMs: 10000000, tokenBudget: 10000000 }).budgetMs, 900000);
  assert.equal(resolveProfile({ tokenBudget: 10000000 }).tokenBudget, 250000);
  for (const value of [-1, 0, Infinity, NaN, '5000']) assert.throws(() => resolveProfile({ tokenBudget: value }));
  assert.throws(() => resolveProfile({ profile: 'unknown' }));
});

test('concurrent reservations preserve capacity for the final judge', () => {
  const b = new TokenBudget(10000, { reportReserve: 2000 });
  const first = b.reserve(5000, { role: 'build-C1' });
  const second = b.reserve(3000, { role: 'build-C2' });
  assert.throws(() => b.reserve(1, { role: 'attack' }), /available/);
  const report = b.reserve(2000, { role: 'semantic-judge' });
  b.settle(first, 4000); b.settle(second, 1000); b.settle(report, 1000);
  assert.equal(b.snapshot().observed, 6000); assert.equal(b.snapshot().remaining, 4000);
});

test('unknown billed usage retains reservation; overrun blocks new work', () => {
  const b = new TokenBudget(10000, { reportReserve: 0 });
  b.settle(b.reserve(5000), null);
  assert.equal(b.snapshot().unknownReserved, 5000);
  assert.equal(b.snapshot().usageIncomplete, true);
  b.settle(b.reserve(5000), 6000);
  assert.equal(b.snapshot().exceeded, true);
  assert.throws(() => b.reserve(1), /available/);
});

test('interrupted sessions retain unreported allowance after partial usage events', () => {
  const b = new TokenBudget(10000, {reportReserve:0});
  b.settle(b.reserve(6000), 2000, {incomplete:true});
  assert.equal(b.snapshot().observed,2000); assert.equal(b.snapshot().unknownReserved,4000);
  assert.equal(b.snapshot().remaining,4000); assert.equal(b.snapshot().usageIncomplete,true);
});

test('each failed format attempt is charged before reserving the retry', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'katse-budget-'));
  const budget = new TokenBudget(20000, { reportReserve: 0 }); let calls = 0;
  const opts = { dir, artifacts: dir, role: 'contract', model: 'mock', prompt: 'test', noTools: true, maxOutputTokens: 1000,
    execute: async () => { calls++; return { code: 0, stderr: '', ms: 1, stdout: [
      JSON.stringify({type:'text',part:{text:calls === 1 ? 'invalid' : '{"ok":true}'}}),
      JSON.stringify({type:'step_finish',part:{tokens:{total:1200,input:1000,output:200}}}),
    ].join('\n') }; } };
  await execution.run({tokenBudget:budget}, () => session(opts));
  assert.equal(calls, 2); assert.equal(budget.snapshot().observed, 2400); assert.equal(budget.snapshot().reserved, 0);
});

test('insufficient reservation and excessive context never invoke a model', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'katse-budget-')); let calls = 0;
  const opts = { dir, artifacts: dir, role: 'contract', model: 'mock', prompt: 'test', noTools:true, execute: async () => { calls++; throw new Error('unexpected'); } };
  await assert.rejects(execution.run({tokenBudget:new TokenBudget(100)}, () => session(opts)), /available/);
  await assert.rejects(session({...opts,maxInputTokens:10}), /context-limit/);
  assert.equal(calls, 0);
});

test('output caps use model.limit.output for both OpenCode config versions', () => {
  const c = configuration({maxOutputTokens:1536});
  assert.equal(c.provider['verda-nemotron'].models.nemotron.limit.output,1536);
  assert.equal(c.providers['verda-nemotron'].models.nemotron.limit.output,1536);
  for (const m of Object.values(c.provider.google.models)) assert.equal(m.limit.output,1536);
  for (const m of Object.values(c.providers.google.models)) assert.equal(m.limit.output,1536);
});

test('Nemotron direct-answer mode is default and thinking remains explicit', () => {
  const original = process.env.KATSE_VERDA_THINKING;
  try {
    delete process.env.KATSE_VERDA_THINKING;
    assert.equal(configuration().provider['verda-nemotron'].models.nemotron.options.chat_template_kwargs.enable_thinking,false);
    process.env.KATSE_VERDA_THINKING = 'true';
    assert.equal(configuration().provider['verda-nemotron'].models.nemotron.options.chat_template_kwargs.enable_thinking,true);
  } finally { if(original === undefined) delete process.env.KATSE_VERDA_THINKING; else process.env.KATSE_VERDA_THINKING = original; }
});

test('output exhausted entirely by reasoning does not repeat the same capped request', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'katse-budget-'));let calls=0;
  await assert.rejects(session({dir,artifacts:dir,role:'build-C2',model:'mock',prompt:'test',noTools:true,execute:async()=>{
    calls++;return {code:0,stderr:'',ms:1,stdout:JSON.stringify({type:'step_finish',part:{reason:'length',tokens:{input:100,output:0,reasoning:4096,total:4196}}})};
  }}),/session-output-limit/);
  assert.equal(calls,1);
});

test('no-tool builder keeps its role but cannot read, edit or loop through files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'katse-budget-'));
  await session({dir,artifacts:dir,role:'build-C1',model:'mock',prompt:'test',noTools:true,execute:async (_exe,_args,options)=>{
    const cfg=JSON.parse(options.env.OPENCODE_CONFIG_CONTENT);
    assert.equal(cfg.agent.katse.steps,2);
    for(const action of ['read','list','glob','grep','edit']) assert.equal(cfg.permission[action],'deny');
    return {code:0,stdout:JSON.stringify({type:'text',part:{text:'{"ok":true}'}}),stderr:'',ms:1};
  }});
});

test('Entire attachment refuses the source repo and any scratch repo with remotes', async () => {
  await assert.rejects(attachSession(process.cwd(), 'ses_test'), /outside|contains/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'katse-test-'));
  const dir = path.join(root,'repo'); fs.mkdirSync(dir);
  await run('git',['init','-q'],{cwd:dir});
  await run('git',['remote','add','origin','https://example.invalid/repo'],{cwd:dir});
  const head = fs.readFileSync(path.join(dir,'.git','HEAD'),'utf8');
  await assert.rejects(attachSession(dir,'ses_test'), /with remotes/);
  assert.equal(fs.readFileSync(path.join(dir,'.git','HEAD'),'utf8'),head);
});

const catalogue = url => ({ok:true,json:async()=>url.includes('googleapis') ? {models:[models().fast,models().review].map(m=>({name:`models/${m.split('/')[1]}`}))} : {data:[{id:process.env.KATSE_VERDA_MODEL || 'nemotron-3.5-super-vl'}]}});
const versionCheck = async () => ({code:0,stdout:'test-version',stderr:''});

test('preflight retries a transient timeout once and records the provider', async () => {
  let googleCalls=0;
  const result=await providerPreflight({cache:false,execute:versionCheck,fetchImpl:async url=>{
    if(url.includes('googleapis') && ++googleCalls===1) throw Object.assign(new Error('timeout'),{name:'TimeoutError'});
    return catalogue(url);
  }});
  assert.equal(googleCalls,2);assert.equal(result.preflight.attempts.Google,2);
});

test('preflight never retries auth or quota errors and waits for sibling tools', async () => {
  for(const status of [401,403,429]) {
    let googleCalls=0,finishedTools=0;
    await assert.rejects(providerPreflight({cache:false,execute:async()=>{await new Promise(resolve=>setTimeout(resolve,10));finishedTools++;return {code:0,stdout:'version'};},fetchImpl:async url=>{
      if(url.includes('googleapis')){googleCalls++;return {ok:false,status};}return catalogue(url);
    }}),new RegExp(`Google: HTTP ${status} after 1 attempt`));
    assert.equal(googleCalls,1);assert.equal(finishedTools,2);
  }
});

test('preflight retries server failure once but respects remaining review time', async () => {
  let calls=0;
  const fetchImpl=async url=>{if(url.includes('googleapis')){calls++;return {ok:false,status:503};}return catalogue(url);};
  await assert.rejects(providerPreflight({cache:false,execute:versionCheck,fetchImpl}),/Google: HTTP 503 after 2 attempt/);
  assert.equal(calls,2);calls=0;
  await assert.rejects(execution.run({deadline:Date.now()+500},()=>providerPreflight({cache:false,execute:versionCheck,fetchImpl})),/after 1 attempt/);
  assert.equal(calls,1);
});

test('successful preflight cache expires and credentials invalidate it', async () => {
  clearPreflightCache();let time=0,calls=0;const original=process.env.GEMINI_API_KEY;
  const opts={now:()=>time,execute:versionCheck,fetchImpl:async url=>{calls++;return catalogue(url);}};
  try {
    const first=await providerPreflight(opts);assert.equal(first.preflight.cached,false);assert.equal(calls,2);
    const cached=await providerPreflight(opts);assert.equal(cached.preflight.cached,true);assert.equal(calls,2);
    process.env.GEMINI_API_KEY='synthetic-test-credential';
    const changed=await providerPreflight(opts);assert.equal(changed.preflight.cached,false);assert.equal(calls,4);
    time=300001;await providerPreflight(opts);assert.equal(calls,6);
    assert.ok(!JSON.stringify(changed).includes('synthetic-test-credential'));
  } finally { if(original===undefined)delete process.env.GEMINI_API_KEY;else process.env.GEMINI_API_KEY=original;clearPreflightCache(); }
});

test('partial preflight preserves Google when Verda fails and never caches failure', async () => {
  clearPreflightCache();let verdaCalls=0;
  const opts={allowPartial:true,execute:versionCheck,fetchImpl:async url=>{
    if(!url.includes('googleapis')){verdaCalls++;throw Object.assign(new Error('timeout'),{name:'TimeoutError'});}return catalogue(url);
  }};
  const result=await providerPreflight(opts);
  assert.deepEqual(result.available,{fast:true,review:true,diverse:false});
  assert.equal(result.authenticated,false);assert.equal(result.preflight.partial,true);
  assert.match(result.errors[0],/Verda\/Nemotron: network timeout after 2 attempt/);
  await providerPreflight(opts);assert.equal(verdaCalls,4);
  await assert.rejects(providerPreflight({...opts,allowPartial:false}),/Verda\/Nemotron/);
});

test('partial preflight reports missing capture tooling without blocking model availability', async () => {
  const result=await providerPreflight({allowPartial:true,cache:false,fetchImpl:async url=>catalogue(url),execute:async(_exe,args)=>args[0]==='version'?{code:1,stdout:'',stderr:'failure'}:versionCheck()});
  assert.deepEqual(result.available,{fast:true,review:true,diverse:true});
  assert.equal(result.tools.entire,false);assert.equal(result.entire,null);
  assert.equal(result.authenticated,false);assert.match(result.errors[0],/Entire/);
});

test('partial preflight does not call a provider with missing credentials', async () => {
  const original=process.env.VERDA_INFERENCE_KEY;delete process.env.VERDA_INFERENCE_KEY;let calls=0;
  try {
    const result=await providerPreflight({allowPartial:true,cache:false,execute:versionCheck,fetchImpl:async url=>{calls++;return catalogue(url);}});
    assert.equal(calls,1);assert.equal(result.available.fast,true);assert.equal(result.available.diverse,false);
    assert.match(result.errors[0],/missing VERDA_INFERENCE_KEY/);
  } finally {process.env.VERDA_INFERENCE_KEY=original;}
});
