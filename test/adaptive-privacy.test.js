import test from 'node:test';
import assert from 'node:assert/strict';
import {populationPlan,allocateGroup,groupMission,updateGroups} from '../server/planner.js';
import {PrivacyGateway,privacyMode,PUBLIC_TIETO,localURL} from '../server/privacy.js';
import {decisionMissions} from '../server/decisions.js';
import {privateGenerate} from '../server/private-generation.js';
import {execution} from '../server/execution.js';
import {session} from '../server/agents.js';
import {liveToken} from '../server/live.js';
import {ask} from '../server/llm.js';
import {generate} from '../server/consensus/gemini.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const group=(id='G1')=>({id,risk:3,unverified:1,disagreement:null,estimatedMs:45000,explored:0,expectations:['E1'],symbol:'Collect',file:'src/Code.cs',start:1,end:20});
const contract={expectations:[{id:'E1',behavior:'Preserve diagnostics'}]};
test('strict deployment blocks legacy cloud paths before any request',async()=>{
  const old=process.env.KATSE_PRIVACY_MODE;process.env.KATSE_PRIVACY_MODE='strict';
  try {
    await assert.rejects(liveToken(),/Strict privacy blocks/);
    await assert.rejects(ask('private input'),/Strict privacy blocks/);
    await assert.rejects(generate({contents:[]}),/Strict privacy blocks/);
  } finally {if(old===undefined)delete process.env.KATSE_PRIVACY_MODE;else process.env.KATSE_PRIVACY_MODE=old;}
});
test('population responds to complexity but never exceeds time, tokens or profile',()=>{
  const p={id:'deep'}; const resources={remainingMs:600000,tokens:100000};
  assert.equal(populationPlan([{...group(),risk:2}],p,resources).admitted,2);
  assert.equal(populationPlan([group(),group('G2')],p,resources).admitted,4);
  assert.equal(populationPlan([group()],{id:'standard'},resources).admitted,2);
  assert.equal(populationPlan([group()],p,{...resources,remainingMs:60000}).admitted,0);
  assert.equal(populationPlan([group()],p,{...resources,tokens:18000}).admitted,0);
});
test('concurrent allocation reserves groups and missions carry actual requirements',()=>{
  const groups=[group(),group('G2')];
  assert.equal(allocateGroup(groups).id,'G1');assert.equal(allocateGroup(groups).id,'G2');
  const mission=JSON.parse(groupMission(groups[1],contract,'preserve'));
  assert.equal(mission.group,'G2');assert.equal(mission.expectations[0].behavior,'Preserve diagnostics');
  updateGroups(groups,[{id:'A',status:'admitted',expectations:['E1']}],[{version:'original',outcome:'failed'},{version:'C1',outcome:'passed'}],(a,e)=>e.outcome);
  assert.equal(groups[0].unverified,1);assert.equal(groups[0].disagreement,1);
});
test('Gemma is loopback only; public exception pins both code and base',()=>{
  assert.throws(()=>new PrivacyGateway({mode:'strcit'}));
  for(const url of ['https://remote.com','http://localhost.evil.com','http://user:pass@localhost'])assert.throws(()=>localURL(url));
  assert.equal(privacyMode({proposed:PUBLIC_TIETO,historicalBase:'32258fdbee4bcd653c79f51b4376b5103c6f4d27'}),'public-tieto-demo');
  assert.equal(privacyMode({proposed:PUBLIC_TIETO,historicalBase:'different'}),'strict');
  assert.equal(privacyMode({proposed:PUBLIC_TIETO,historicalBase:'32258fdbee4bcd653c79f51b4376b5103c6f4d27',requirement:{id:'user-input'}}),'strict');
});
test('local privacy masks secrets, PII and internal identifiers, restores patches and caches',async()=>{
  let calls=0;
  const gate=new PrivacyGateway({fetcher:async(url,req)=>{calls++;assert.match(url,/127.0.0.1/);assert.ok(!req.body.includes('alice@example.com'));assert.ok(!req.body.includes('secret-value'));return Response.json({done:true,response:JSON.stringify({complete:true,uncertain:false,spans:['AcmeLedger']})});}});
  const prompt='class AcmeLedger {} // alice@example.com password="secret-value"';
  const result=await gate.prepare(prompt);
  for(const raw of ['AcmeLedger','alice@example.com','secret-value'])assert.ok(!result.text.includes(raw));
  assert.equal(result.restore({code:result.text}).code,prompt);
  const second=await gate.prepare(prompt);assert.equal(second.text,result.text);
  assert.ok(calls<=2);assert.ok(!JSON.stringify(gate.snapshot()).includes('AcmeLedger'));
});
test('missing, malformed, uncertain and truncated Gemma responses block cloud transmission',async()=>{
  for(const reply of [{done:false,response:'{}'},{done:true,response:'bad'},{done:true,response:JSON.stringify({complete:true,uncertain:true,spans:[]})},{done:true,response:JSON.stringify({complete:true,uncertain:false,spans:['invented']})}]) {
    const gate=new PrivacyGateway({fetcher:async()=>Response.json(reply)});
    await assert.rejects(gate.prepare('private code'),/Privacy blocked/);assert.equal(gate.snapshot().blocked,1);
  }
  await assert.rejects(new PrivacyGateway({fetcher:async()=>{throw Error('offline')}}).prepare('private code'),/Privacy blocked/);
});
test('strict generation sends only the sanitized message; no tool or workspace context',async()=>{
  const gate=new PrivacyGateway({terms:['AcmeLedger'],fetcher:async()=>Response.json({done:true,response:'{"complete":true,"uncertain":false,"spans":[]}'})});
  const clean=await gate.prepare('class AcmeLedger {}');
  await assert.rejects(privateGenerate('google/gemini-4-hydrogen',clean.text,500,0,{fetcher:()=>{throw Error('Should not fetch');}}),/deadline exhausted/);
  await privateGenerate('google/gemini-4-hydrogen',clean.text,500,1000,{fetcher:async(url,req)=>{
    assert.ok(!req.body.includes('AcmeLedger'));assert.ok(!req.body.includes('tools'));assert.ok(!req.body.includes('cwd'));
    return Response.json({candidates:[{content:{parts:[{text:'{}'}]}}],usageMetadata:{totalTokenCount:12}});
  }});
});
test('decision router accepts only confident closed choices and gracefully falls back',async()=>{
  const old=process.env.GEMINI_API_KEY;process.env.GEMINI_API_KEY='synthetic';
  try {
    const g=[group()];
    const r=await decisionMissions(g,contract,{fetcher:async()=>Response.json({answers:{G1:{choice:'boundary',confidence:0.95}},usageMetadata:{totalTokenCount:10}})});
    assert.equal(r.missions.G1,'boundary');assert.equal(r.tokens,10);
    const low=await decisionMissions(g,contract,{fetcher:async()=>Response.json({answers:{G1:{choice:'boundary',confidence:0.2}}})});assert.equal(low.missions.G1,'preserve');
    for(const choice of ['approve','skip-tests']) {const bad=await decisionMissions(g,contract,{fetcher:async()=>Response.json({answers:{G1:{choice,confidence:1}}})});assert.equal(bad.status,'fallback');assert.equal(bad.missions.G1,'preserve');}
    const down=await decisionMissions(g,contract,{fetcher:async()=>new Response('',{status:429})});assert.equal(down.reason,'HTTP 429');
  } finally {if(old===undefined)delete process.env.GEMINI_API_KEY;else process.env.GEMINI_API_KEY=old;}
});
test('private session blocks before calling either OpenCode or a cloud provider',async()=>{
  const gate=new PrivacyGateway({fetcher:async()=>{throw Error('offline');}});
  let executions=0;
  await assert.rejects(execution.run({privacy:gate},()=>session({dir:os.tmpdir(),artifacts:os.tmpdir(),role:'contract',model:'google/gemini-4-hydrogen',prompt:'private-company-code',execute:async()=>{executions++;}})),/Privacy blocked/);
  assert.equal(executions,0);
});
test('strict session never invokes workspace tools and restores validated local edits',async()=>{
  const originalFetch=globalThis.fetch,dir=fs.mkdtempSync(path.join(os.tmpdir(),'katse-privacy-test-'));
  let cloudCalls=0;
  const gate=new PrivacyGateway({terms:['PrivateLedger'],fetcher:async()=>Response.json({done:true,response:'{"complete":true,"uncertain":false,"spans":[]}'})});
  globalThis.fetch=async(url,request)=>{cloudCalls++;assert.ok(!request.body.includes('PrivateLedger'));const message=JSON.parse(request.body).contents[0].parts[0].text;const alias=message.match(/KATSE_PRIVATE_\d+/)[0];return Response.json({candidates:[{content:{parts:[{text:JSON.stringify({name:alias})}]}}],usageMetadata:{totalTokenCount:20}});};
  try {
    const result=await execution.run({privacy:gate},()=>session({dir,artifacts:dir,role:'build-C1',model:'google/gemini-4-hydrogen',prompt:'Repair PrivateLedger',noTools:true,execute:async()=>{throw Error('Must not invoke OpenCode');},validate:x=>x.name==='PrivateLedger'}));
    assert.equal(result.result.name,'PrivateLedger');assert.equal(result.transport,'direct-sanitized-text');assert.equal(result.sessionId,undefined);assert.equal(cloudCalls,1);
  } finally {globalThis.fetch=originalFetch;fs.rmSync(dir,{recursive:true,force:true});}
});
