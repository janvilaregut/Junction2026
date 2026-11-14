import test from 'node:test';
import assert from 'node:assert/strict';
import { adjudicate } from '../server/pipeline/evidence.js';

const contract = () => ({hash:'contract-1',expectations:[{id:'E1',critical:true,status:'documented',sources:[{id:'ticket',quote:'must preserve this behavior'}]}]});
const attack = (id='A1') => ({id,status:'admitted',hypothesis:'The original might fail',scenario:'boundary input',expected:'preserved behavior',expectations:['E1'],names:['KatseAttack'],riskKey:'boundary',attacker:'nemotron',originCandidate:'C1'});
const evidence = (id,version='original',status='passed',extra={}) => ({id,version,status,contractHash:'contract-1',codeHash:version==='original'?'original-tree':'candidate-tree',testHash:'tests-1',environment:{sdk:'8'},commands:{test:['dotnet','test']},scope:'relevant-suite',attacks:['A1'],ran:1,executionComplete:true,tests:[{name:'KatseAttack',outcome:status==='passed'?'Passed':'Failed',error:status==='passed'?null:'expected preserved behavior'}],...extra});
const input = () => ({contract:contract(),attacks:[attack()],evidence:[evidence('o1'),evidence('o2','original','passed',{attempt:'reproduction'}),evidence('c1','C1','failed')],baseline:{l2:{suite:{ok:true,ran:170}}},semantic:{ambiguities:[],contradictions:[]},complete:true,requiredFinalMissions:1,finalMissions:[{complete:true}],candidates:[{id:'C1',final:true,checkpoint:{status:'missing'}}]});

test('failing final candidate and missing Entire are audit limits, not rejection of original',()=>{
  const v=adjudicate(input());
  assert.equal(v.status,'ready-for-human'); assert.equal(v.score.value,8);
  assert.equal(v.findings[0].classification,'candidate-only');
  assert.ok(v.auditWarnings.some(s=>s.includes('checkpoint')));
  assert.equal(v.findings[0].agent,'nemotron'); assert.equal(v.findings[0].sources[0].id,'ticket');
  assert.deepEqual(v.findings[0].outcomes.map(o=>o.version),['original','original','C1']);
});

test('missing original full suite cannot be hidden by a successful candidate suite',()=>{
  const x=input(); x.evidence=x.evidence.map(e=>e.version==='original'?{...e,scope:'attacks'}:{...e,status:'passed'});
  const v=adjudicate(x); assert.equal(v.status,'insufficient-evidence');
  assert.ok(v.pending.some(p=>p.startsWith('Original relevant suite')));
  assert.equal(v.score.components.find(c=>c.id==='regressions').earned,0);
});

test('critical unsupported expectation caps score even when all executed tests pass',()=>{
  const x=input();x.contract.expectations.push({id:'E2',critical:true,status:'pending',sources:[]});
  const v=adjudicate(x);assert.equal(v.status,'insufficient-evidence');assert.ok(v.score.value<=5);
  assert.ok(v.score.caps.some(c=>c.max===5));
});

test('no execution is not scored as bad code',()=>{
  const x=input();x.evidence=[];x.baseline={l2:{suite:{ok:false,ran:0}}};
  const v=adjudicate(x);assert.equal(v.score.value,null);assert.equal(v.status,'insufficient-evidence');
});

test('reproduced critical original failure caps score and records base attribution',()=>{
  const x=input();x.evidence=[evidence('o1','original','failed'),evidence('o2','original','failed'),evidence('b1','historical-base','passed')];
  const v=adjudicate(x);assert.equal(v.status,'request-changes');assert.ok(v.score.value<=2);
  assert.equal(v.findings[0].classification,'confirmed-original');assert.equal(v.findings[0].attribution,'regression-from-base');
  assert.equal(v.verified.length,0);
});

test('cached evidence cannot supply independent reproduction points or confirm failure',()=>{
  const x=input();x.evidence=[evidence('o1'),evidence('o2','original','passed',{reused:true})];
  assert.equal(adjudicate(x).score.components.find(c=>c.id==='reproducibility').earned,0);
  x.evidence=[evidence('o1','original','failed'),evidence('o2','original','failed',{reused:true})];
  assert.equal(adjudicate(x).confirmed.length,0);
});

test('extra variants of one risk do not inflate attack points',()=>{
  const x=input();x.requiredFinalMissions=3;x.finalMissions=[1,2,3].map(()=>({complete:true}));
  const before=adjudicate(x).score.components.find(c=>c.id==='attacks').earned;
  x.attacks=Array.from({length:100},(_,i)=>attack(`A${i+1}`));
  x.evidence=x.evidence.map(e=>({...e,attacks:x.attacks.map(a=>a.id)}));
  const after=adjudicate(x).score.components.find(c=>c.id==='attacks').earned;
  assert.equal(before,after);
});

test('an invalid or unfounded accusation is never confirmed',()=>{
  const x=input();x.attacks[0].expectations=['invented'];x.evidence=[evidence('o1','original','failed'),evidence('o2','original','failed')];
  const v=adjudicate(x);assert.equal(v.confirmed.length,0);assert.equal(v.findings[0].classification,'invalid-test');
});

test('historical and alternate versions sharing an execution ID do not erase original results',()=>{
  const x=input();x.evidence.push({...evidence('o1','historical-base'),reused:true});
  const v=adjudicate(x);assert.equal(v.status,'ready-for-human');
  assert.ok(v.findings[0].outcomes.some(o=>o.version==='original'));
});

test('pending orchestration checks cap the score in the same deterministic evaluation',()=>{
  const x=input();x.extraPending=['Required external dependency validation incomplete'];
  const v=adjudicate(x);assert.equal(v.status,'insufficient-evidence');assert.ok(v.score.value<=7);
});


test('review profile cannot inflate score by reducing the required final mission count',()=>{
  const x=input();const one=adjudicate(x).score.components.find(c=>c.id==='attacks').earned;
  x.requiredFinalMissions=3;x.finalMissions=[1,2,3].map(()=>({complete:true}));
  assert.equal(adjudicate(x).score.components.find(c=>c.id==='attacks').earned,one);
});

test('existing tests require explicit source-backed mapping; suite totals alone give no contract support',()=>{
  const x=input();x.attacks=[];x.contract.sources=[{id:'base-tests',kind:'test',text:'public void ExistingRegression() verifies the requirement'}];
  x.contract.expectations[0].existingTests=['ExistingRegression'];
  x.contract.expectations[0].sources=[{id:'base-tests',quote:'ExistingRegression() verifies the requirement'}];
  x.evidence=[evidence('suite','original','passed',{attacks:[],tests:[{name:'Suite.ExistingRegression',outcome:'Passed'}]})];
  let v=adjudicate(x);assert.deepEqual(v.verified,['E1']);assert.equal(v.support[0].source,'existing-tests');
  x.contract.expectations[0].existingTests=['UnrelatedTest'];
  v=adjudicate(x);assert.deepEqual(v.verified,[]);assert.ok(v.score.value<=5);
});

test('a separate passing scenario never erases a confirmed failure of the same expectation',()=>{
  const x=input();x.attacks.push({...attack('A2'),names:['KatseOther']});
  x.evidence=[evidence('f1','original','failed'),evidence('f2','original','failed'),evidence('p1','original','passed',{attacks:['A2'],tests:[{name:'KatseOther',outcome:'Passed'}]})];
  const v=adjudicate(x);assert.equal(v.status,'request-changes');assert.deepEqual(v.verified,[]);assert.ok(v.score.value<=2);
});


test('analyst contract ambiguities block approval even when semantic reviewer reports none',()=>{
  const x=input();x.contract.ambiguities=['External diagnostic behavior is unspecified'];
  const v=adjudicate(x);assert.equal(v.status,'insufficient-evidence');
  assert.ok(v.pending.some(p=>p.startsWith('Contract ambiguity unresolved:')));
});

test('noncritical labels cannot approve a contract with zero supported behaviors',()=>{
  const x=input();x.contract.expectations[0].critical=false;x.attacks=[];
  x.evidence=x.evidence.map(e=>({...e,attacks:[]}));x.requiredFinalMissions=0;x.finalMissions=[];
  const v=adjudicate(x);assert.equal(v.status,'insufficient-evidence');assert.deepEqual(v.verified,[]);
  assert.ok(v.pending.includes('No contract behavior has executable support'));
});
